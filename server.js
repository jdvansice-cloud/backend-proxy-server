const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: '*', // Open for testing - restrict to your domain in production
    credentials: true
}));
app.use(express.json());

// Mindbody API configuration
const MINDBODY_API_BASE = 'https://api.mindbodyonline.com/public/v6';
const API_KEY = process.env.MINDBODY_API_KEY || 'e1acf5c4136e461991395b31edcb7cd7';
const SITE_ID = process.env.MINDBODY_SITE_ID || '-99';

// Store user token temporarily (in production, use proper session management)
let userTokenCache = {};

// Helper function to make Mindbody API requests
async function mindbodyRequest(endpoint, method = 'GET', data = null, userToken = null) {
    const headers = {
        'Api-Key': API_KEY,
        'SiteId': SITE_ID,
        'Content-Type': 'application/json'
    };

    if (userToken) {
        headers['Authorization'] = userToken;
    }

    try {
        const config = {
            method,
            url: `${MINDBODY_API_BASE}${endpoint}`,
            headers,
        };

        if (data && (method === 'POST' || method === 'PUT')) {
            config.data = data;
        } else if (data && method === 'GET') {
            config.params = data;
        }

        const response = await axios(config);
        return response.data;
    } catch (error) {
        console.error(`Mindbody API Error (${endpoint}):`, error.response?.data || error.message);
        throw error;
    }
}

// ============================================
// ROOT & HEALTH CHECK ENDPOINTS
// ============================================

// Root endpoint with API information
app.get('/', (req, res) => {
    res.json({ 
        status: 'OK', 
        message: 'Mimosa Spa Booking Proxy Server',
        version: '2.0',
        endpoints: [
            'GET  / - This info',
            'GET  /api/health - Health check',
            'POST /api/auth/login - Client authentication',
            'POST /api/auth/client-login - Client login with info',
            'GET  /api/client - Get client info',
            'GET  /api/locations - Get all locations',
            'GET  /api/session-types - Get appointment types',
            'GET  /api/services - Get services (alternative)',
            'GET  /api/staff - Get therapists',
            'GET  /api/appointment-availability - Get available slots',
            'GET  /api/bookable-items - Get bookable items',
            'GET  /api/active-session-times - Get active times',
            'POST /api/book - Create appointment',
            'POST /api/book-appointment - Create appointment (alternative)',
            'GET  /api/client-appointments - Get client bookings'
        ],
        mindbody: {
            apiVersion: 'v6.0',
            siteId: SITE_ID
        }
    });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'Mimosa Spa - Mindbody Proxy Server is running',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// ============================================
// AUTHENTICATION ENDPOINTS
// ============================================

// Simple login endpoint (returns token only)
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        const response = await mindbodyRequest(
            '/usertoken/issue',
            'POST',
            { Username: username, Password: password }
        );

        res.json({
            success: true,
            token: response.AccessToken
        });
    } catch (error) {
        res.status(401).json({
            success: false,
            message: error.response?.data?.Error?.Message || 'Authentication failed'
        });
    }
});

// Client login/validation
app.post('/api/auth/client-login', async (req, res) => {
    try {
        const { username, password } = req.body;

        // First get user token
        const tokenResponse = await mindbodyRequest(
            '/usertoken/issue',
            'POST',
            { Username: username, Password: password }
        );

        // Then get client info
        const clientResponse = await mindbodyRequest(
            '/client/clients',
            'GET',
            { SearchText: username },
            tokenResponse.AccessToken
        );

        if (clientResponse.Clients && clientResponse.Clients.length > 0) {
            const client = clientResponse.Clients[0];
            
            // Cache the token
            const sessionId = Date.now().toString();
            userTokenCache[sessionId] = tokenResponse.AccessToken;

            res.json({
                success: true,
                sessionId,
                token: tokenResponse.AccessToken,
                client: {
                    id: client.Id,
                    firstName: client.FirstName,
                    lastName: client.LastName,
                    email: client.Email
                }
            });
        } else {
            res.status(404).json({
                success: false,
                error: 'Client not found'
            });
        }
    } catch (error) {
        res.status(401).json({
            success: false,
            error: 'Invalid credentials'
        });
    }
});

// Get client info
app.get('/api/client', async (req, res) => {
    try {
        const { username } = req.query;
        const authToken = req.headers.authorization;

        const response = await axios.get(
            `${MINDBODY_API_BASE}/client/clients?searchText=${username}`,
            {
                headers: {
                    'Api-Key': API_KEY,
                    'SiteId': SITE_ID,
                    'Authorization': authToken
                }
            }
        );

        res.json(response.data);
    } catch (error) {
        res.status(error.response?.status || 500).json({
            error: error.response?.data || error.message
        });
    }
});

// ============================================
// LOCATION ENDPOINTS
// ============================================

app.get('/api/locations', async (req, res) => {
    try {
        const response = await mindbodyRequest('/site/locations');
        
        const locations = response.Locations.map(loc => ({
            id: loc.Id,
            name: loc.Name,
            address: loc.Address,
            address2: loc.Address2,
            city: loc.City,
            state: loc.StateProvCode,
            postalCode: loc.PostalCode,
            phone: loc.Phone,
            description: loc.Description
        }));

        res.json({ locations });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch locations' });
    }
});

// ============================================
// SESSION TYPE ENDPOINTS (Services/Appointments)
// ============================================

app.get('/api/session-types', async (req, res) => {
    try {
        const { locationId } = req.query;
        const authToken = req.headers.authorization;
        
        const params = {
            OnlineOnly: true
        };

        if (locationId) {
            params.LocationIds = [parseInt(locationId)];
        }

        const response = await mindbodyRequest('/site/sessiontypes', 'GET', params, authToken);
        
        const sessionTypes = response.SessionTypes
            .filter(st => st.Type === 'Appointment')
            .map(st => ({
                id: st.Id,
                name: st.Name,
                numDeducted: st.NumDeducted,
                programId: st.ProgramId,
                defaultTimeLength: st.DefaultTimeLength,
                category: st.Category
            }));

        res.json({ sessionTypes });
    } catch (error) {
        console.error('Error fetching session types:', error);
        res.status(500).json({ error: 'Failed to fetch session types' });
    }
});

// Get services (alternative endpoint)
app.get('/api/services', async (req, res) => {
    try {
        const { locationId } = req.query;
        const authToken = req.headers.authorization;

        const response = await axios.get(
            `${MINDBODY_API_BASE}/site/services${locationId ? `?locationId=${locationId}` : ''}`,
            {
                headers: {
                    'Api-Key': API_KEY,
                    'SiteId': SITE_ID,
                    'Authorization': authToken
                }
            }
        );

        res.json(response.data);
    } catch (error) {
        res.status(error.response?.status || 500).json({
            error: error.response?.data || error.message
        });
    }
});

// ============================================
// STAFF ENDPOINTS
// ============================================

app.get('/api/staff', async (req, res) => {
    try {
        const { sessionTypeId, locationId } = req.query;
        
        const params = {};

        if (sessionTypeId) {
            params.SessionTypeIds = [parseInt(sessionTypeId)];
        }
        
        if (locationId) {
            params.LocationId = parseInt(locationId);
        }

        const response = await mindbodyRequest('/staff/staff', 'GET', params);
        
        const staff = response.StaffMembers.map(member => ({
            id: member.Id,
            firstName: member.FirstName,
            lastName: member.LastName,
            name: `${member.FirstName} ${member.LastName}`,
            imageUrl: member.ImageUrl,
            bio: member.Bio,
            gender: member.Gender,
            isMale: member.IsMale,
            appointmentTrn: member.AppointmentTrn
        }));

        res.json({ staff });
    } catch (error) {
        console.error('Error fetching staff:', error);
        res.status(500).json({ error: 'Failed to fetch staff' });
    }
});

// ============================================
// APPOINTMENT AVAILABILITY ENDPOINTS
// ============================================

app.get('/api/appointment-availability', async (req, res) => {
    try {
        const { sessionTypeId, staffId, locationId, startDate, endDate } = req.query;

        if (!sessionTypeId) {
            return res.status(400).json({ error: 'sessionTypeId is required' });
        }

        const params = {
            SessionTypeIds: [parseInt(sessionTypeId)],
            StartDate: startDate || new Date().toISOString(),
            EndDate: endDate || new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
        };

        if (staffId) {
            params.StaffIds = [parseInt(staffId)];
        }

        if (locationId) {
            params.LocationIds = [parseInt(locationId)];
        }

        const response = await mindbodyRequest('/appointment/bookableitems', 'GET', params);
        
        const availability = [];
        
        if (response.BookableItems) {
            response.BookableItems.forEach(item => {
                if (item.ScheduleItems) {
                    item.ScheduleItems.forEach(scheduleItem => {
                        availability.push({
                            startDateTime: scheduleItem.StartDateTime,
                            endDateTime: scheduleItem.EndDateTime,
                            staffId: item.StaffId,
                            staffName: `${item.StaffMember?.FirstName || ''} ${item.StaffMember?.LastName || ''}`.trim(),
                            locationId: item.LocationId,
                            sessionTypeId: item.SessionType?.Id,
                            sessionTypeName: item.SessionType?.Name,
                            duration: scheduleItem.Duration || item.SessionType?.DefaultTimeLength
                        });
                    });
                }
            });
        }

        res.json({ availability });
    } catch (error) {
        console.error('Error fetching appointment availability:', error);
        res.status(500).json({ 
            error: 'Failed to fetch appointment availability',
            details: error.response?.data || error.message
        });
    }
});

// Get active session times
app.get('/api/active-session-times', async (req, res) => {
    try {
        const { sessionTypeIds, staffIds, startDate, endDate, locationIds } = req.query;

        const params = {
            SchedulingWindow: true,
            StartDate: startDate || new Date().toISOString(),
            EndDate: endDate || new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
        };

        if (sessionTypeIds) {
            params.SessionTypeIds = Array.isArray(sessionTypeIds) ? sessionTypeIds.map(Number) : [Number(sessionTypeIds)];
        }

        if (staffIds) {
            params.StaffIds = Array.isArray(staffIds) ? staffIds.map(Number) : [Number(staffIds)];
        }

        if (locationIds) {
            params.LocationIds = Array.isArray(locationIds) ? locationIds.map(Number) : [Number(locationIds)];
        }

        const response = await mindbodyRequest('/appointment/activesessiontimes', 'GET', params);
        
        res.json(response);
    } catch (error) {
        console.error('Error fetching active session times:', error);
        res.status(500).json({ 
            error: 'Failed to fetch active session times',
            details: error.response?.data || error.message
        });
    }
});

// Get bookable items
app.get('/api/bookable-items', async (req, res) => {
    try {
        const authToken = req.headers.authorization;
        const queryString = new URLSearchParams(req.query).toString();

        const response = await axios.get(
            `${MINDBODY_API_BASE}/appointment/bookableitems?${queryString}`,
            {
                headers: {
                    'Api-Key': API_KEY,
                    'SiteId': SITE_ID,
                    'Authorization': authToken
                }
            }
        );

        res.json(response.data);
    } catch (error) {
        res.status(error.response?.status || 500).json({
            error: error.response?.data || error.message
        });
    }
});

// ============================================
// BOOKING ENDPOINTS
// ============================================

// Book appointment (comprehensive version)
app.post('/api/book-appointment', async (req, res) => {
    try {
        const { 
            clientId, 
            sessionTypeId, 
            staffId, 
            locationId, 
            startDateTime,
            sessionId,
            notes,
            sendEmail = true
        } = req.body;

        if (!clientId || !sessionTypeId || !staffId || !locationId || !startDateTime) {
            return res.status(400).json({ 
                error: 'Missing required fields',
                required: ['clientId', 'sessionTypeId', 'staffId', 'locationId', 'startDateTime']
            });
        }

        const userToken = userTokenCache[sessionId];
        if (!userToken) {
            return res.status(401).json({ error: 'Session expired. Please login again.' });
        }

        const appointmentData = {
            ClientId: clientId.toString(),
            SessionTypeId: parseInt(sessionTypeId),
            StaffId: parseInt(staffId),
            LocationId: parseInt(locationId),
            StartDateTime: startDateTime,
            SendEmail: sendEmail,
            Test: false
        };

        if (notes) {
            appointmentData.Notes = notes;
        }

        const response = await mindbodyRequest(
            '/appointment/addappointment',
            'POST',
            appointmentData,
            userToken
        );

        res.json({
            success: true,
            appointment: response.Appointment
        });
    } catch (error) {
        console.error('Error booking appointment:', error);
        res.status(500).json({ 
            error: 'Failed to book appointment',
            details: error.response?.data || error.message
        });
    }
});

// Book appointment (simple version)
app.post('/api/book', async (req, res) => {
    try {
        const authToken = req.headers.authorization;

        const response = await axios.post(
            `${MINDBODY_API_BASE}/appointment/addappointment`,
            req.body,
            {
                headers: {
                    'Api-Key': API_KEY,
                    'SiteId': SITE_ID,
                    'Authorization': authToken,
                    'Content-Type': 'application/json'
                }
            }
        );

        res.json({
            success: true,
            appointment: response.data
        });
    } catch (error) {
        res.status(error.response?.status || 500).json({
            error: error.response?.data || error.message
        });
    }
});

// Get client appointments
app.get('/api/client-appointments', async (req, res) => {
    try {
        const { clientId, sessionId, startDate, endDate } = req.query;

        if (!clientId) {
            return res.status(400).json({ error: 'clientId is required' });
        }

        const userToken = userTokenCache[sessionId];

        const params = {
            ClientIds: [clientId],
            StartDate: startDate || new Date().toISOString(),
            EndDate: endDate || new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
        };

        const response = await mindbodyRequest(
            '/appointment/staffappointments',
            'GET',
            params,
            userToken
        );

        res.json(response);
    } catch (error) {
        console.error('Error fetching client appointments:', error);
        res.status(500).json({ 
            error: 'Failed to fetch appointments',
            details: error.response?.data || error.message
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`✅ Mimosa Spa Proxy Server running on port ${PORT}`);
    console.log(`✅ Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`✅ Mindbody API: ${MINDBODY_API_BASE}`);
    console.log(`✅ Site ID: ${SITE_ID}`);
    console.log(`📍 Health check: http://localhost:${PORT}/api/health`);
});
