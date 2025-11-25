/**
 * Mindbody API Proxy Server - CORRECTED VERSION
 * 
 * KEY FIX: Uses GetBookableItems as the primary source for staff availability
 * instead of filtering staff first and checking availability individually.
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Configuration - ALL values must come from environment variables
const CONFIG = {
    baseUrl: 'https://api.mindbodyonline.com/public/v6',
    siteId: process.env.MINDBODY_SITE_ID || '',
    apiKey: process.env.MINDBODY_API_KEY || '',
    username: process.env.MINDBODY_USERNAME || '',
    password: process.env.MINDBODY_PASSWORD || ''
};

// Validate required config on startup
if (!CONFIG.apiKey || !CONFIG.siteId || !CONFIG.username || !CONFIG.password) {
    console.error('❌ ERROR: Missing required environment variables!');
    console.error('Required: MINDBODY_API_KEY, MINDBODY_SITE_ID, MINDBODY_USERNAME, MINDBODY_PASSWORD');
}

// Token cache
let cachedToken = null;
let tokenExpiry = null;

/**
 * Get or refresh access token
 */
async function getAccessToken() {
    // Check if token is still valid (with 5 min buffer)
    if (cachedToken && tokenExpiry && Date.now() < tokenExpiry - 300000) {
        return cachedToken;
    }
    
    try {
        console.log('🔑 Getting new access token...');
        const response = await axios.post(
            `${CONFIG.baseUrl}/usertoken/issue`,
            {
                Username: CONFIG.username,
                Password: CONFIG.password
            },
            {
                headers: {
                    'Api-Key': CONFIG.apiKey,
                    'SiteId': CONFIG.siteId,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        cachedToken = response.data.AccessToken;
        // Token typically expires in 7 days, but refresh more often
        tokenExpiry = Date.now() + (24 * 60 * 60 * 1000); // 24 hours
        console.log('✅ Token obtained successfully');
        return cachedToken;
    } catch (error) {
        console.error('❌ Token error:', error.response?.data || error.message);
        throw error;
    }
}

/**
 * Make authenticated API call
 */
async function callMindbodyAPI(endpoint, method = 'GET', data = null, userToken = null) {
    const token = userToken || await getAccessToken();
    
    const config = {
        method,
        url: `${CONFIG.baseUrl}${endpoint}`,
        headers: {
            'Api-Key': CONFIG.apiKey,
            'SiteId': CONFIG.siteId,
            'Authorization': token,
            'Content-Type': 'application/json'
        }
    };
    
    if (data && method === 'POST') {
        config.data = data;
    }
    
    console.log(`📡 ${method} ${endpoint}`);
    const response = await axios(config);
    return response.data;
}

// ============================================
// ROUTES
// ============================================

/**
 * Health check
 */
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        message: 'Mindbody Proxy Server (Corrected Version)',
        timestamp: new Date().toISOString(),
        siteId: CONFIG.siteId
    });
});

/**
 * PUBLIC DEBUG ENDPOINT - Test bookable items directly
 * Usage: /api/test-bookable?sessionTypeId=XX&locationId=1
 * No authentication required - uses server credentials
 */
app.get('/api/test-bookable', async (req, res) => {
    try {
        const { sessionTypeId, locationId } = req.query;
        
        if (!sessionTypeId) {
            return res.json({
                error: 'Missing sessionTypeId parameter',
                usage: '/api/test-bookable?sessionTypeId=XX&locationId=1',
                hint: 'First call /api/test-session-types to find session type IDs'
            });
        }
        
        console.log('🧪 TEST: Fetching bookable items...');
        console.log('   sessionTypeId:', sessionTypeId);
        console.log('   locationId:', locationId || '(all)');
        
        const token = await getAccessToken();
        
        // Get today and 14 days from now
        const today = new Date();
        const twoWeeksLater = new Date(today);
        twoWeeksLater.setDate(today.getDate() + 14);
        
        const startDate = today.toISOString().split('T')[0];
        const endDate = twoWeeksLater.toISOString().split('T')[0];
        
        console.log('   Date range:', startDate, 'to', endDate);
        
        // Build query params
        let endpoint = `/appointment/bookableitems?sessionTypeIds=${sessionTypeId}&startDate=${startDate}&endDate=${endDate}`;
        if (locationId) {
            endpoint += `&locationIds=${locationId}`;
        }
        
        console.log('   Full endpoint:', endpoint);
        
        const response = await axios.get(
            `${CONFIG.baseUrl}${endpoint}`,
            {
                headers: {
                    'Api-Key': CONFIG.apiKey,
                    'SiteId': CONFIG.siteId,
                    'Authorization': token,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        const data = response.data;
        const scheduleItems = data.Availabilities || data.ScheduleItems || [];
        
        // Extract unique staff
        const staffMap = {};
        scheduleItems.forEach(item => {
            const staffId = item.Staff?.Id;
            if (staffId && !staffMap[staffId]) {
                staffMap[staffId] = {
                    id: staffId,
                    name: `${item.Staff?.FirstName || ''} ${item.Staff?.LastName || ''}`.trim(),
                    slotCount: 0
                };
            }
            if (staffId) staffMap[staffId].slotCount++;
        });
        
        console.log('✅ TEST RESULTS:');
        console.log('   Total slots:', scheduleItems.length);
        console.log('   Staff found:', Object.keys(staffMap).length);
        
        res.json({
            success: true,
            test: {
                sessionTypeId,
                locationId: locationId || 'all',
                dateRange: { start: startDate, end: endDate }
            },
            results: {
                totalSlots: scheduleItems.length,
                staffWithAvailability: Object.values(staffMap),
                firstFewSlots: scheduleItems.slice(0, 5).map(item => ({
                    date: item.StartDateTime,
                    staff: item.Staff?.FirstName + ' ' + item.Staff?.LastName,
                    sessionType: item.SessionType?.Name
                }))
            },
            rawResponse: {
                hasAvailabilities: !!data.Availabilities,
                availabilitiesCount: data.Availabilities?.length || 0,
                paginationResponse: data.PaginationResponse
            }
        });
        
    } catch (error) {
        console.error('❌ Test error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data || error.message,
            hint: 'Check that sessionTypeId is valid and service is bookable online'
        });
    }
});

/**
 * PUBLIC DEBUG - List all session types with IDs
 */
app.get('/api/test-session-types', async (req, res) => {
    try {
        console.log('🧪 TEST: Fetching all session types...');
        
        const token = await getAccessToken();
        
        const response = await axios.get(
            `${CONFIG.baseUrl}/site/sessiontypes?limit=200`,
            {
                headers: {
                    'Api-Key': CONFIG.apiKey,
                    'SiteId': CONFIG.siteId,
                    'Authorization': token,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        const sessionTypes = response.data.SessionTypes || [];
        
        // Group by type
        const byType = {};
        sessionTypes.forEach(st => {
            const type = st.Type || 'Unknown';
            if (!byType[type]) byType[type] = [];
            byType[type].push({
                id: st.Id,
                name: st.Name,
                duration: st.DefaultTimeLength,
                onlinePrice: st.OnlinePrice,
                programId: st.ProgramId
            });
        });
        
        console.log('✅ Found', sessionTypes.length, 'session types');
        
        res.json({
            success: true,
            totalCount: sessionTypes.length,
            byType: byType,
            hint: 'Use any ID from above with /api/test-bookable?sessionTypeId=XX'
        });
        
    } catch (error) {
        console.error('❌ Session types error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data || error.message
        });
    }
});

/**
 * 1a. Auto-Login (uses server-stored credentials - RECOMMENDED)
 * This keeps credentials secure on the backend
 */
app.post('/api/auth/auto-login', async (req, res) => {
    try {
        console.log('🔐 Auto-login with server credentials...');
        
        const response = await axios.post(
            `${CONFIG.baseUrl}/usertoken/issue`,
            { 
                Username: CONFIG.username, 
                Password: CONFIG.password 
            },
            {
                headers: {
                    'Api-Key': CONFIG.apiKey,
                    'SiteId': CONFIG.siteId,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        console.log('✅ Auto-login successful');
        
        res.json({
            success: true,
            accessToken: response.data.AccessToken,
            user: response.data.User
        });
    } catch (error) {
        console.error('Auto-login error:', error.response?.data || error.message);
        res.status(401).json({
            success: false,
            error: error.response?.data?.Error?.Message || 'Authentication failed'
        });
    }
});

/**
 * 1b. User Authentication (for client login - if needed)
 */
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        const response = await axios.post(
            `${CONFIG.baseUrl}/usertoken/issue`,
            { Username: username, Password: password },
            {
                headers: {
                    'Api-Key': CONFIG.apiKey,
                    'SiteId': CONFIG.siteId,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        res.json({
            success: true,
            accessToken: response.data.AccessToken,
            user: response.data.User
        });
    } catch (error) {
        console.error('Login error:', error.response?.data || error.message);
        res.status(401).json({
            success: false,
            error: error.response?.data?.Error?.Message || 'Authentication failed'
        });
    }
});

/**
 * 2. Get Locations
 */
app.get('/api/locations', async (req, res) => {
    try {
        const userToken = req.headers.authorization;
        const data = await callMindbodyAPI('/site/locations', 'GET', null, userToken);
        
        res.json({
            success: true,
            locations: data.Locations || []
        });
    } catch (error) {
        console.error('Locations error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.Error?.Message || error.message
        });
    }
});

/**
 * 3. Get Session Types (Services/Appointments)
 */
app.get('/api/session-types', async (req, res) => {
    try {
        const userToken = req.headers.authorization;
        const { locationId, onlineOnly } = req.query;
        
        let endpoint = '/site/sessiontypes';
        const params = new URLSearchParams();
        
        if (onlineOnly === 'true') params.append('OnlineOnly', 'true');
        if (locationId) params.append('LocationIds', locationId);
        
        if (params.toString()) {
            endpoint += `?${params.toString()}`;
        }
        
        const data = await callMindbodyAPI(endpoint, 'GET', null, userToken);
        
        // Filter for Appointment types only (not Classes)
        const appointmentTypes = (data.SessionTypes || []).filter(st => 
            st.Type === 'Appointment' || st.Type === 'Service'
        );
        
        res.json({
            success: true,
            sessionTypes: appointmentTypes,
            allTypes: data.SessionTypes || []
        });
    } catch (error) {
        console.error('Session types error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.Error?.Message || error.message
        });
    }
});

/**
 * 4. Get Staff (basic list - NOT for availability!)
 */
app.get('/api/staff', async (req, res) => {
    try {
        const userToken = req.headers.authorization;
        const { locationId, sessionTypeIds } = req.query;
        
        let endpoint = '/staff/staff';
        const params = new URLSearchParams();
        
        if (locationId) params.append('LocationId', locationId);
        if (sessionTypeIds) params.append('SessionTypeIds', sessionTypeIds);
        
        if (params.toString()) {
            endpoint += `?${params.toString()}`;
        }
        
        const data = await callMindbodyAPI(endpoint, 'GET', null, userToken);
        
        res.json({
            success: true,
            staff: data.StaffMembers || []
        });
    } catch (error) {
        console.error('Staff error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.Error?.Message || error.message
        });
    }
});

/**
 * 5. ⭐ GET BOOKABLE ITEMS - THE KEY ENDPOINT! ⭐
 * 
 * This endpoint returns AVAILABLE appointment slots with staff info.
 * Use this to determine which staff have availability!
 */
app.get('/api/bookable-items', async (req, res) => {
    try {
        const userToken = req.headers.authorization;
        const { sessionTypeIds, locationIds, staffIds, startDate, endDate } = req.query;
        
        // Build query params
        const params = new URLSearchParams();
        
        // Required: sessionTypeIds
        if (sessionTypeIds) {
            params.append('sessionTypeIds', sessionTypeIds);
        }
        
        // Optional filters
        if (locationIds) params.append('locationIds', locationIds);
        if (staffIds) params.append('staffIds', staffIds);
        
        // Default to today + 14 days if not specified
        const start = startDate || new Date().toISOString().split('T')[0];
        const end = endDate || new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        
        params.append('startDate', start);
        params.append('endDate', end);
        
        const endpoint = `/appointment/bookableitems?${params.toString()}`;
        console.log('📅 Fetching bookable items:', params.toString());
        
        const data = await callMindbodyAPI(endpoint, 'GET', null, userToken);
        
        // DEBUG: Log raw response from Mindbody
        console.log('📦 RAW Mindbody Response Keys:', Object.keys(data));
        console.log('📦 Availabilities count:', data.Availabilities?.length || 0);
        
        // Check for different response structures
        // NOTE: Mindbody returns "Availabilities" NOT "ScheduleItems"!
        let scheduleItems = data.Availabilities || data.ScheduleItems || data.BookableItems || [];
        
        // If empty, log more details
        if (scheduleItems.length === 0) {
            console.log('⚠️ No Availabilities found. Response keys:', Object.keys(data));
        } else {
            console.log('✅ First schedule item sample:', JSON.stringify(scheduleItems[0], null, 2));
        }
        
        console.log(`✅ Found ${scheduleItems.length} bookable slots`);
        
        // Extract unique staff from the bookable items
        const staffMap = new Map();
        scheduleItems.forEach(item => {
            if (item.Staff) {
                const staffId = item.Staff.Id;
                if (!staffMap.has(staffId)) {
                    staffMap.set(staffId, {
                        id: staffId,
                        firstName: item.Staff.FirstName,
                        lastName: item.Staff.LastName,
                        name: `${item.Staff.FirstName || ''} ${item.Staff.LastName || ''}`.trim(),
                        gender: item.Staff.Gender,
                        imageUrl: item.Staff.ImageUrl,
                        slots: []
                    });
                }
                staffMap.get(staffId).slots.push({
                    startDateTime: item.StartDateTime,
                    endDateTime: item.EndDateTime,
                    sessionType: item.SessionType,
                    location: item.Location
                });
            }
        });
        
        // Convert to array and sort by slot count
        const staffWithAvailability = Array.from(staffMap.values())
            .map(s => ({
                ...s,
                availableSlots: s.slots.length
            }))
            .sort((a, b) => b.availableSlots - a.availableSlots);
        
        console.log(`👥 Staff with availability: ${staffWithAvailability.length}`);
        
        res.json({
            success: true,
            // Return ALL formats for compatibility
            Availabilities: scheduleItems,  // What Mindbody actually returns
            ScheduleItems: scheduleItems,   // PascalCase (legacy)
            scheduleItems: scheduleItems,   // camelCase (legacy)
            StaffWithAvailability: staffWithAvailability,
            staffWithAvailability: staffWithAvailability,
            totalSlots: scheduleItems.length,
            dateRange: { start, end },
            debug: {
                rawResponseKeys: Object.keys(data),
                paginationInfo: data.PaginationResponse
            }
        });
        
    } catch (error) {
        console.error('❌ Bookable items error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.Error?.Message || error.message,
            debug: {
                fullError: error.response?.data
            }
        });
    }
});

/**
 * 6. Get Staff WITH Availability (uses bookable-items internally)
 * 
 * This is a convenience endpoint that wraps bookable-items
 * and returns only the staff who have availability.
 */
app.get('/api/staff-with-availability', async (req, res) => {
    try {
        const userToken = req.headers.authorization;
        const { sessionTypeIds, locationIds, startDate, endDate } = req.query;
        
        if (!sessionTypeIds) {
            return res.status(400).json({
                success: false,
                error: 'sessionTypeIds is required'
            });
        }
        
        // Build query params
        const params = new URLSearchParams();
        params.append('sessionTypeIds', sessionTypeIds);
        if (locationIds) params.append('locationIds', locationIds);
        
        const start = startDate || new Date().toISOString().split('T')[0];
        const end = endDate || new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        params.append('startDate', start);
        params.append('endDate', end);
        
        const endpoint = `/appointment/bookableitems?${params.toString()}`;
        const data = await callMindbodyAPI(endpoint, 'GET', null, userToken);
        
        // NOTE: Mindbody returns "Availabilities" not "ScheduleItems"
        const scheduleItems = data.Availabilities || data.ScheduleItems || [];
        
        // Extract and deduplicate staff
        const staffMap = new Map();
        scheduleItems.forEach(item => {
            if (item.Staff) {
                const staffId = item.Staff.Id;
                if (!staffMap.has(staffId)) {
                    staffMap.set(staffId, {
                        Id: staffId,
                        FirstName: item.Staff.FirstName,
                        LastName: item.Staff.LastName,
                        Name: `${item.Staff.FirstName || ''} ${item.Staff.LastName || ''}`.trim(),
                        Gender: item.Staff.Gender,
                        ImageUrl: item.Staff.ImageUrl,
                        Bio: item.Staff.Bio,
                        availableSlotCount: 0,
                        availableSlots: []
                    });
                }
                staffMap.get(staffId).availableSlotCount++;
                staffMap.get(staffId).availableSlots.push({
                    StartDateTime: item.StartDateTime,
                    EndDateTime: item.EndDateTime
                });
            }
        });
        
        const staffWithAvailability = Array.from(staffMap.values())
            .sort((a, b) => b.availableSlotCount - a.availableSlotCount);
        
        res.json({
            success: true,
            staff: staffWithAvailability,
            totalStaffWithAvailability: staffWithAvailability.length,
            totalAvailableSlots: scheduleItems.length,
            dateRange: { startDate: start, endDate: end },
            message: staffWithAvailability.length === 0 
                ? 'No therapists have availability in the selected date range. Try a different date range or check if schedules are configured in Mindbody.'
                : `Found ${staffWithAvailability.length} therapists with ${scheduleItems.length} total available slots.`
        });
        
    } catch (error) {
        console.error('Staff availability error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.Error?.Message || error.message
        });
    }
});

/**
 * 7. Get Available Time Slots for a Specific Staff Member
 */
app.get('/api/available-slots', async (req, res) => {
    try {
        const userToken = req.headers.authorization;
        const { sessionTypeIds, locationIds, staffId, startDate, endDate } = req.query;
        
        const params = new URLSearchParams();
        if (sessionTypeIds) params.append('sessionTypeIds', sessionTypeIds);
        if (locationIds) params.append('locationIds', locationIds);
        if (staffId) params.append('staffIds', staffId);
        
        const start = startDate || new Date().toISOString().split('T')[0];
        const end = endDate || new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        params.append('startDate', start);
        params.append('endDate', end);
        
        const endpoint = `/appointment/bookableitems?${params.toString()}`;
        const data = await callMindbodyAPI(endpoint, 'GET', null, userToken);
        
        // NOTE: Mindbody returns "Availabilities" not "ScheduleItems"
        const scheduleItems = data.Availabilities || data.ScheduleItems || [];
        
        // Group by date
        const slotsByDate = {};
        scheduleItems.forEach(item => {
            const date = item.StartDateTime.split('T')[0];
            if (!slotsByDate[date]) {
                slotsByDate[date] = [];
            }
            slotsByDate[date].push({
                startDateTime: item.StartDateTime,
                endDateTime: item.EndDateTime,
                staff: item.Staff,
                sessionType: item.SessionType
            });
        });
        
        res.json({
            success: true,
            slots: scheduleItems,
            slotsByDate: slotsByDate,
            totalSlots: scheduleItems.length
        });
        
    } catch (error) {
        console.error('Available slots error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.Error?.Message || error.message
        });
    }
});

/**
 * 8. Book Appointment
 */
app.post('/api/appointments/book', async (req, res) => {
    try {
        const userToken = req.headers.authorization;
        
        // Handle both camelCase and PascalCase
        const startDateTime = req.body.startDateTime || req.body.StartDateTime;
        const locationId = req.body.locationId || req.body.LocationId;
        const staffId = req.body.staffId || req.body.StaffId;
        const clientId = req.body.clientId || req.body.ClientId;
        const sessionTypeId = req.body.sessionTypeId || req.body.SessionTypeId;
        const applyPayment = req.body.applyPayment || req.body.ApplyPayment || false;
        const sendEmail = req.body.sendEmail !== undefined ? req.body.sendEmail : true;
        const notes = req.body.notes || req.body.Notes;
        
        console.log('📅 Booking appointment:');
        console.log('   Client:', clientId);
        console.log('   SessionType:', sessionTypeId);
        console.log('   Staff:', staffId);
        console.log('   Location:', locationId);
        console.log('   DateTime:', startDateTime);
        
        const appointmentData = {
            StartDateTime: startDateTime,
            LocationId: locationId,
            StaffId: staffId,
            ClientId: clientId,
            SessionTypeId: sessionTypeId,
            ApplyPayment: applyPayment,
            SendEmail: sendEmail
        };
        
        if (notes) {
            appointmentData.Notes = notes;
        }
        
        const data = await callMindbodyAPI(
            '/appointment/addappointment',
            'POST',
            appointmentData,
            userToken
        );
        
        console.log('✅ Appointment booked! ID:', data.Appointment?.Id);
        
        res.json({
            success: true,
            appointment: data.Appointment,
            message: 'Appointment booked successfully!'
        });
        
    } catch (error) {
        console.error('❌ Booking error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.Error?.Message || error.message
        });
    }
});

/**
 * 9. Get Client Info / Search Clients
 */
app.get('/api/clients', async (req, res) => {
    try {
        const userToken = req.headers.authorization;
        const { searchText, email } = req.query;
        
        let endpoint = '/client/clients';
        const params = new URLSearchParams();
        
        if (searchText) params.append('SearchText', searchText);
        
        if (params.toString()) {
            endpoint += `?${params.toString()}`;
        }
        
        const data = await callMindbodyAPI(endpoint, 'GET', null, userToken);
        
        let clients = data.Clients || [];
        
        // If searching by email, filter results
        if (email) {
            clients = clients.filter(c => 
                c.Email && c.Email.toLowerCase() === email.toLowerCase()
            );
        }
        
        res.json({
            success: true,
            clients: clients
        });
        
    } catch (error) {
        console.error('Clients error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.Error?.Message || error.message
        });
    }
});

/**
 * 10. Client Login - Validate customer credentials
 */
app.post('/api/clients/login', async (req, res) => {
    try {
        const userToken = req.headers.authorization;
        const { username, password } = req.body;
        
        console.log('🔐 Client login attempt:', username);
        
        // Use Mindbody's client credential validation
        const response = await axios.post(
            `${CONFIG.baseUrl}/client/validateclientcredentials`,
            {
                Username: username,
                Password: password
            },
            {
                headers: {
                    'Api-Key': CONFIG.apiKey,
                    'SiteId': CONFIG.siteId,
                    'Authorization': userToken,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        if (response.data && response.data.Client) {
            console.log('✅ Client authenticated:', response.data.Client.FirstName);
            res.json({
                success: true,
                client: response.data.Client
            });
        } else {
            throw new Error('Credenciales incorrectas');
        }
        
    } catch (error) {
        console.error('❌ Client login error:', error.response?.data || error.message);
        res.status(401).json({
            success: false,
            error: error.response?.data?.Error?.Message || 'Email o contraseña incorrectos'
        });
    }
});

/**
 * 10b. Client Forgot Password - Send reset email
 */
app.post('/api/clients/forgot-password', async (req, res) => {
    try {
        const userToken = req.headers.authorization;
        const { email } = req.body;
        
        console.log('🔑 Password reset request for:', email);
        
        // Use Mindbody's send password reset email endpoint
        const response = await axios.post(
            `${CONFIG.baseUrl}/client/sendpasswordresetemail`,
            {
                UserEmail: email,
                UserFirstName: '',  // Optional, will be looked up
                UserLastName: ''    // Optional, will be looked up
            },
            {
                headers: {
                    'Api-Key': CONFIG.apiKey,
                    'SiteId': CONFIG.siteId,
                    'Authorization': userToken,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        console.log('✅ Password reset email sent to:', email);
        res.json({
            success: true,
            message: 'Email de recuperación enviado'
        });
        
    } catch (error) {
        console.error('❌ Forgot password error:', error.response?.data || error.message);
        // Even if there's an error, we don't want to reveal if the email exists or not
        // So we return success anyway for security
        res.json({
            success: true,
            message: 'Si el email existe, recibirás un enlace de recuperación'
        });
    }
});

/**
 * 11. Add New Client (with password for account creation)
 */
app.post('/api/clients', async (req, res) => {
    try {
        const userToken = req.headers.authorization;
        // Handle both camelCase and PascalCase
        const firstName = req.body.firstName || req.body.FirstName;
        const lastName = req.body.lastName || req.body.LastName;
        const email = req.body.email || req.body.Email;
        const phone = req.body.phone || req.body.MobilePhone;
        const birthDate = req.body.birthDate || req.body.BirthDate;
        const address = req.body.address || req.body.AddressLine1;
        const gender = req.body.gender || req.body.Gender;
        const referredBy = req.body.referredBy || req.body.ReferredBy;
        const password = req.body.password || req.body.Password;
        
        const clientData = {
            FirstName: firstName,
            LastName: lastName,
            Email: email,
            // Required fields for Mindbody
            AddressLine1: address || 'Panama',
            Gender: gender || 'Female',
            ReferredBy: referredBy || 'Website'
        };
        
        if (phone) clientData.MobilePhone = phone;
        if (birthDate) clientData.BirthDate = birthDate;
        
        // Add password for consumer credentials if provided
        if (password) {
            clientData.Password = password;
            clientData.SendAccountEmails = true;  // Send welcome email with login info
        }
        
        console.log('📝 Creating client:', firstName, lastName, email);
        console.log('   Address:', clientData.AddressLine1);
        console.log('   Gender:', clientData.Gender);
        console.log('   ReferredBy:', clientData.ReferredBy);
        console.log('   Has Password:', !!password);
        
        const data = await callMindbodyAPI(
            '/client/addclient',
            'POST',
            clientData,
            userToken
        );
        
        console.log('✅ Client created:', data.Client?.Id);
        
        res.json({
            success: true,
            client: data.Client
        });
        
    } catch (error) {
        console.error('Add client error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.Error?.Message || error.message
        });
    }
});

/**
 * 11. Debug endpoint - Raw API call
 */
app.get('/api/debug/raw', async (req, res) => {
    try {
        const userToken = req.headers.authorization;
        const { endpoint } = req.query;
        
        if (!endpoint) {
            return res.status(400).json({ error: 'endpoint query param required' });
        }
        
        const data = await callMindbodyAPI(endpoint, 'GET', null, userToken);
        res.json(data);
        
    } catch (error) {
        res.status(500).json({
            error: error.response?.data || error.message
        });
    }
});

/**
 * 12. Debug endpoint - Test bookable items with full logging
 */
app.get('/api/debug/bookable-items', async (req, res) => {
    try {
        const userToken = req.headers.authorization;
        const { sessionTypeIds, locationIds } = req.query;
        
        const start = new Date().toISOString().split('T')[0];
        const end = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        
        // Try the bookable items endpoint
        const endpoint = `/appointment/bookableitems?sessionTypeIds=${sessionTypeIds}&locationIds=${locationIds}&startDate=${start}&endDate=${end}`;
        
        console.log('🔍 DEBUG: Calling endpoint:', endpoint);
        
        const data = await callMindbodyAPI(endpoint, 'GET', null, userToken);
        
        res.json({
            endpoint: endpoint,
            responseKeys: Object.keys(data),
            availabilitiesCount: data.Availabilities?.length || 0,
            scheduleItemsCount: data.ScheduleItems?.length || 0,
            bookableItemsCount: data.BookableItems?.length || 0,
            pagination: data.PaginationResponse,
            firstItem: data.Availabilities?.[0] || data.ScheduleItems?.[0] || data.BookableItems?.[0] || null,
            fullResponse: data
        });
        
    } catch (error) {
        res.status(500).json({
            error: error.message,
            fullError: error.response?.data
        });
    }
});

/**
 * 13. Debug endpoint - Get all session types to verify IDs
 */
app.get('/api/debug/session-types', async (req, res) => {
    try {
        const userToken = req.headers.authorization;
        const data = await callMindbodyAPI('/site/sessiontypes', 'GET', null, userToken);
        
        res.json({
            total: data.SessionTypes?.length || 0,
            sessionTypes: data.SessionTypes?.map(st => ({
                Id: st.Id,
                Name: st.Name,
                Type: st.Type,
                DefaultTimeLength: st.DefaultTimeLength,
                NumDeducted: st.NumDeducted,
                ProgramId: st.ProgramId
            })) || []
        });
        
    } catch (error) {
        res.status(500).json({
            error: error.message,
            fullError: error.response?.data
        });
    }
});

/**
 * 14. Debug endpoint - Get staff for a session type
 */
app.get('/api/debug/staff', async (req, res) => {
    try {
        const userToken = req.headers.authorization;
        const { sessionTypeIds, locationId } = req.query;
        
        let endpoint = '/staff/staff?';
        if (sessionTypeIds) endpoint += `SessionTypeIds=${sessionTypeIds}&`;
        if (locationId) endpoint += `LocationId=${locationId}`;
        
        const data = await callMindbodyAPI(endpoint, 'GET', null, userToken);
        
        res.json({
            total: data.StaffMembers?.length || 0,
            staff: data.StaffMembers?.map(s => ({
                Id: s.Id,
                FirstName: s.FirstName,
                LastName: s.LastName,
                AppointmentInstructor: s.AppointmentInstructor,
                IndependentContractor: s.IndependentContractor,
                AlwaysAllowDoubleBooking: s.AlwaysAllowDoubleBooking
            })) || []
        });
        
    } catch (error) {
        res.status(500).json({
            error: error.message,
            fullError: error.response?.data
        });
    }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║     Mindbody Proxy Server (CORRECTED VERSION)              ║
╠════════════════════════════════════════════════════════════╣
║  🚀 Running on port: ${PORT}                                   ║
║  📍 Site ID: ${CONFIG.siteId}                                       ║
║  🔑 API Key: ${CONFIG.apiKey ? 'Configured' : 'NOT SET'}                            ║
╠════════════════════════════════════════════════════════════╣
║  KEY ENDPOINTS:                                            ║
║  • GET  /api/bookable-items      ← Primary availability!   ║
║  • GET  /api/staff-with-availability ← Staff + slots       ║
║  • GET  /api/available-slots     ← Time slots for booking  ║
╚════════════════════════════════════════════════════════════╝
    `);
});

module.exports = app;
