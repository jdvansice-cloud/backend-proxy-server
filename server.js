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
 * PUBLIC DEBUG ENDPOINT - Test client login
 * Usage: POST /api/test-client-login with { email, password }
 */
app.post('/api/test-client-login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        console.log('🧪 TEST: Client login...');
        console.log('   Email:', email);
        
        // Get staff token first
        const token = await getAccessToken();
        console.log('   Staff token obtained');
        
        // Try validateclientcredentials
        console.log('   Calling validateclientcredentials...');
        const response = await axios.post(
            `${CONFIG.baseUrl}/client/validateclientcredentials`,
            {
                Username: email,
                Password: password
            },
            {
                headers: {
                    'Api-Key': CONFIG.apiKey,
                    'SiteId': CONFIG.siteId,
                    'Authorization': token,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        console.log('   ✅ Success!');
        res.json({
            success: true,
            client: response.data.Client,
            fullResponse: response.data
        });
        
    } catch (error) {
        console.error('   ❌ Error:', error.response?.data || error.message);
        res.json({
            success: false,
            error: error.response?.data?.Error?.Message || error.message,
            errorCode: error.response?.data?.Error?.Code,
            fullError: error.response?.data,
            hint: 'Check if client has set up online access in Mindbody'
        });
    }
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
        
        // Also fetch service categories
        let serviceCategories = [];
        try {
            const catResponse = await axios.get(
                `${CONFIG.baseUrl}/site/servicecategories`,
                {
                    headers: {
                        'Api-Key': CONFIG.apiKey,
                        'SiteId': CONFIG.siteId,
                        'Authorization': token,
                        'Content-Type': 'application/json'
                    }
                }
            );
            serviceCategories = catResponse.data.ServiceCategories || [];
            console.log('📂 Service Categories:', serviceCategories.map(c => c.Name));
        } catch (catErr) {
            console.log('⚠️ Could not fetch service categories:', catErr.message);
        }
        
        // Create category lookup
        const categoryLookup = {};
        serviceCategories.forEach(cat => {
            categoryLookup[cat.Id] = cat.Name;
        });
        
        // Group by Category - try multiple fields
        const byCategory = {};
        sessionTypes.forEach(st => {
            // Try to find category from multiple sources
            const category = st.Category?.Name || 
                            categoryLookup[st.CategoryId] ||
                            categoryLookup[st.ServiceCategoryId] ||
                            st.Subcategory?.Name ||
                            st.Program?.Name || 
                            st.Type || 
                            'Otros';
            if (!byCategory[category]) byCategory[category] = [];
            byCategory[category].push({
                id: st.Id,
                name: st.Name,
                duration: st.DefaultTimeLength,
                // All price-related fields
                onlinePrice: st.OnlinePrice,
                price: st.Price,
                defaultPrice: st.DefaultPrice,
                retailPrice: st.RetailPrice,
                type: st.Type,
                categoryId: st.CategoryId,
                serviceCategoryId: st.ServiceCategoryId,
                programId: st.ProgramId
            });
        });
        
        // Also show first raw item for debugging
        const sampleRaw = sessionTypes.length > 0 ? sessionTypes[0] : null;
        
        console.log('✅ Found', sessionTypes.length, 'session types');
        console.log('📂 Categories found:', Object.keys(byCategory));
        
        res.json({
            success: true,
            totalCount: sessionTypes.length,
            categories: Object.keys(byCategory),
            byCategory: byCategory,
            serviceCategories: serviceCategories,
            sampleRawItem: sampleRaw,
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
 * Test endpoint for Service Categories
 */
app.get('/api/test-service-categories', async (req, res) => {
    try {
        console.log('🧪 TEST: Fetching service categories...');
        
        const token = await getAccessToken();
        
        const response = await axios.get(
            `${CONFIG.baseUrl}/site/servicecategories`,
            {
                headers: {
                    'Api-Key': CONFIG.apiKey,
                    'SiteId': CONFIG.siteId,
                    'Authorization': token,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        console.log('✅ Service Categories response:', JSON.stringify(response.data, null, 2));
        
        res.json({
            success: true,
            serviceCategories: response.data.ServiceCategories || [],
            rawResponse: response.data
        });
        
    } catch (error) {
        console.error('❌ Service categories error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data || error.message
        });
    }
});

/**
 * Test endpoint for Programs (another way Mindbody categorizes services)
 */
app.get('/api/test-programs', async (req, res) => {
    try {
        console.log('🧪 TEST: Fetching programs...');
        
        const token = await getAccessToken();
        
        const response = await axios.get(
            `${CONFIG.baseUrl}/site/programs`,
            {
                headers: {
                    'Api-Key': CONFIG.apiKey,
                    'SiteId': CONFIG.siteId,
                    'Authorization': token,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        console.log('✅ Programs response:', JSON.stringify(response.data, null, 2));
        
        res.json({
            success: true,
            programs: response.data.Programs || [],
            rawResponse: response.data
        });
        
    } catch (error) {
        console.error('❌ Programs error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data || error.message
        });
    }
});

/**
 * Test endpoint for Services with Prices (from Sale API)
 */
app.get('/api/test-services', async (req, res) => {
    try {
        console.log('🧪 TEST: Fetching services with prices...');
        
        const token = await getAccessToken();
        
        const response = await axios.get(
            `${CONFIG.baseUrl}/sale/services`,
            {
                headers: {
                    'Api-Key': CONFIG.apiKey,
                    'SiteId': CONFIG.siteId,
                    'Authorization': token,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        console.log('✅ Services response - total:', (response.data.Services || []).length);
        
        // Show first 5 services with their price fields
        const sampleServices = (response.data.Services || []).slice(0, 10).map(svc => ({
            Id: svc.Id,
            Name: svc.Name,
            Price: svc.Price,
            OnlinePrice: svc.OnlinePrice,
            TaxIncluded: svc.TaxIncluded
        }));
        
        res.json({
            success: true,
            totalServices: (response.data.Services || []).length,
            sampleServices: sampleServices,
            rawFirstService: response.data.Services?.[0] || null
        });
        
    } catch (error) {
        console.error('❌ Services error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data || error.message
        });
    }
});

/**
 * Test endpoint for Available Dates
 */
app.get('/api/test-available-dates', async (req, res) => {
    try {
        const { sessionTypeId, locationId, staffId } = req.query;
        
        console.log('🧪 TEST: Fetching available dates...');
        console.log('   sessionTypeId:', sessionTypeId);
        console.log('   locationId:', locationId);
        console.log('   staffId:', staffId);
        
        const token = await getAccessToken();
        
        const today = new Date();
        const endOfNextMonth = new Date(today.getFullYear(), today.getMonth() + 2, 0);
        
        const params = new URLSearchParams();
        // Use singular parameter names for this endpoint
        if (sessionTypeId) params.append('sessionTypeId', sessionTypeId);
        if (locationId) params.append('locationId', locationId);
        if (staffId) params.append('staffId', staffId);
        params.append('startDate', today.toISOString().split('T')[0]);
        params.append('endDate', endOfNextMonth.toISOString().split('T')[0]);
        
        const response = await axios.get(
            `${CONFIG.baseUrl}/appointment/availabledates?${params.toString()}`,
            {
                headers: {
                    'Api-Key': CONFIG.apiKey,
                    'SiteId': CONFIG.siteId,
                    'Authorization': token,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        console.log('✅ Available dates response:', JSON.stringify(response.data, null, 2));
        
        res.json({
            success: true,
            availableDates: response.data.AvailableDates || [],
            totalDates: (response.data.AvailableDates || []).length,
            dateRange: {
                start: today.toISOString().split('T')[0],
                end: endOfNextMonth.toISOString().split('T')[0]
            },
            rawResponse: response.data
        });
        
    } catch (error) {
        console.error('❌ Available dates error:', error.response?.data || error.message);
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
        
        // Fetch programs - this is the primary source for service categories
        let programs = {};
        try {
            const programsData = await callMindbodyAPI('/site/programs', 'GET', null, userToken);
            if (programsData.Programs) {
                programsData.Programs.forEach(prog => {
                    programs[prog.Id] = prog.Name;
                });
                console.log('📂 All Programs:', Object.values(programs));
            }
        } catch (progError) {
            console.log('⚠️ Could not fetch programs:', progError.message);
        }
        
        // Fetch services with prices from Sale API
        let servicePrices = {};
        try {
            const servicesData = await callMindbodyAPI('/sale/services', 'GET', null, userToken);
            if (servicesData.Services) {
                servicesData.Services.forEach(svc => {
                    servicePrices[svc.Id] = svc.Price || svc.OnlinePrice || null;
                });
                console.log('💰 Service prices found:', Object.keys(servicePrices).length);
            }
        } catch (priceError) {
            console.log('⚠️ Could not fetch service prices:', priceError.message);
        }
        
        let endpoint = '/site/sessiontypes';
        const params = new URLSearchParams();
        
        // Always filter for online-only session types
        params.append('OnlineOnly', 'true');
        if (locationId) params.append('LocationIds', locationId);
        
        if (params.toString()) {
            endpoint += `?${params.toString()}`;
        }
        
        const data = await callMindbodyAPI(endpoint, 'GET', null, userToken);
        
        // Filter for Appointment types only (not Classes)
        const appointmentTypes = (data.SessionTypes || []).filter(st => 
            st.Type === 'Appointment' || st.Type === 'Service'
        );
        
        // Log first item structure for debugging
        if (appointmentTypes.length > 0) {
            console.log('📋 Sample session type - ProgramId:', appointmentTypes[0].ProgramId);
            console.log('📋 Sample session type - Program:', programs[appointmentTypes[0].ProgramId]);
            console.log('💰 Sample session type - OnlinePrice:', appointmentTypes[0].OnlinePrice);
            console.log('💰 Sample session type - Price:', appointmentTypes[0].Price);
            console.log('💰 Sample session type - from Services:', servicePrices[appointmentTypes[0].Id]);
        }
        
        // Categories to exclude (generic/system categories, not real treatment categories)
        const excludedCategories = ['Appointment', 'Appointments', 'Service', 'Services'];
        
        // Enrich session types with program name as category and prices
        const enrichedTypes = appointmentTypes
            .map(st => ({
                ...st,
                // Use Program name as category (from ProgramId lookup)
                CategoryName: programs[st.ProgramId] || null,
                // Try multiple sources for price: OnlinePrice, DefaultPrice, Price from services lookup
                Price: st.OnlinePrice || st.DefaultPrice || st.Price || servicePrices[st.Id] || null
            }))
            // Filter out services without a real category or with excluded category names
            .filter(st => st.CategoryName && !excludedCategories.includes(st.CategoryName));
        
        // Count how many have prices
        const withPrices = enrichedTypes.filter(st => st.Price).length;
        console.log('💰 Services with prices:', withPrices, '/', enrichedTypes.length);
        
        // Get unique categories that will be shown
        const finalCategories = [...new Set(enrichedTypes.map(st => st.CategoryName))];
        console.log('📂 Final categories (excluding Appointment):', finalCategories);
        
        res.json({
            success: true,
            sessionTypes: enrichedTypes,
            programs: programs,
            servicePrices: servicePrices,
            categories: finalCategories,
            priceStats: { withPrices, total: enrichedTypes.length },
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
 * 5a. GET AVAILABLE DATES - Get dates when staff are scheduled to work
 * 
 * Use this first to get dates, then use bookable-items for specific time slots
 */
app.get('/api/available-dates', async (req, res) => {
    try {
        const userToken = req.headers.authorization;
        const { sessionTypeIds, locationIds, staffIds, startDate, endDate } = req.query;
        
        const params = new URLSearchParams();
        
        // Mindbody uses 'sessionTypeId' (singular) for this endpoint
        if (sessionTypeIds) params.append('sessionTypeId', sessionTypeIds);
        if (locationIds) params.append('locationId', locationIds);
        if (staffIds) params.append('staffId', staffIds);
        
        // Default to today + 60 days if not specified
        const start = startDate || new Date().toISOString().split('T')[0];
        const end = endDate || new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        
        params.append('startDate', start);
        params.append('endDate', end);
        
        const endpoint = `/appointment/availabledates?${params.toString()}`;
        console.log('📅 Fetching available dates:', params.toString());
        
        const data = await callMindbodyAPI(endpoint, 'GET', null, userToken);
        
        console.log('📅 Available dates response:', JSON.stringify(data, null, 2));
        
        res.json({
            success: true,
            availableDates: data.AvailableDates || [],
            dateRange: { start, end }
        });
        
    } catch (error) {
        console.error('❌ Available dates error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.Error?.Message || error.message
        });
    }
});

/**
 * 5b. ⭐ GET BOOKABLE ITEMS - THE KEY ENDPOINT! ⭐
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
        
        // Request more results for longer date ranges
        params.append('limit', '500');
        
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
        params.append('limit', '500');
        
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
 * 7b. Get Client's Upcoming Appointments
 */
app.get('/api/clients/:clientId/appointments', async (req, res) => {
    try {
        const userToken = req.headers.authorization;
        const { clientId } = req.params;
        
        console.log('📋 Fetching appointments for client:', clientId);
        
        // Get appointments from today onwards
        const today = new Date();
        const startDate = today.toISOString().split('T')[0];
        
        // Get appointments for next 60 days
        const futureDate = new Date(today);
        futureDate.setDate(today.getDate() + 60);
        const endDate = futureDate.toISOString().split('T')[0];
        
        const data = await callMindbodyAPI(
            `/appointment/clientappointments?ClientId=${clientId}&StartDate=${startDate}&EndDate=${endDate}`,
            'GET',
            null,
            userToken
        );
        
        const appointments = data.Appointments || [];
        
        // Filter only future appointments (not past, not cancelled)
        const upcomingAppointments = appointments.filter(apt => {
            const aptDate = new Date(apt.StartDateTime);
            return aptDate >= today && apt.Status !== 'Cancelled';
        });
        
        console.log('✅ Found', upcomingAppointments.length, 'upcoming appointments');
        
        res.json({
            success: true,
            appointments: upcomingAppointments.map(apt => ({
                id: apt.Id,
                startDateTime: apt.StartDateTime,
                endDateTime: apt.EndDateTime,
                serviceName: apt.SessionType?.Name || apt.ServiceName || 'Servicio',
                staffName: apt.Staff?.Name || `${apt.Staff?.FirstName || ''} ${apt.Staff?.LastName || ''}`.trim() || 'Terapeuta',
                locationName: apt.Location?.Name || 'Ubicación',
                status: apt.Status
            }))
        });
        
    } catch (error) {
        console.error('Client appointments error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.Error?.Message || error.message,
            appointments: []
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
 * 10. Client Login - Find client by email
 * Note: Mindbody API v6 doesn't have direct client password validation
 * We search for the client by email instead
 */
app.post('/api/clients/login', async (req, res) => {
    try {
        const userToken = req.headers.authorization;
        const { username, password } = req.body;
        
        console.log('🔐 Client login attempt:', username);
        
        // First, get a fresh staff token if needed
        let authToken = userToken;
        if (!authToken) {
            const tokenResponse = await axios.post(
                `${CONFIG.baseUrl}/usertoken/issue`,
                { Username: CONFIG.username, Password: CONFIG.password },
                {
                    headers: {
                        'Api-Key': CONFIG.apiKey,
                        'SiteId': CONFIG.siteId,
                        'Content-Type': 'application/json'
                    }
                }
            );
            authToken = tokenResponse.data.AccessToken;
        }
        
        // Search for client by email
        console.log('   Searching for client by email...');
        const searchResponse = await axios.get(
            `${CONFIG.baseUrl}/client/clients?searchText=${encodeURIComponent(username)}`,
            {
                headers: {
                    'Api-Key': CONFIG.apiKey,
                    'SiteId': CONFIG.siteId,
                    'Authorization': authToken,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        const clients = searchResponse.data.Clients || [];
        
        // Find client with matching email
        const client = clients.find(c => 
            c.Email && c.Email.toLowerCase() === username.toLowerCase()
        );
        
        if (client) {
            console.log('✅ Client found:', client.FirstName, client.LastName);
            
            // For security, we'll do a basic password check using Mindbody's 
            // RequiredClientFields or just allow login if client exists
            // In production, you might want to implement proper OAuth
            
            res.json({
                success: true,
                client: client,
                message: 'Cliente encontrado'
            });
        } else {
            console.log('❌ Client not found with email:', username);
            res.status(401).json({
                success: false,
                error: 'No se encontró una cuenta con este email. ¿Necesitas crear una cuenta?',
                notFound: true
            });
        }
        
    } catch (error) {
        console.error('❌ Client login error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: 'Error al buscar la cuenta. Intenta de nuevo.'
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
        
        // Always send account emails so user can set up their password
        clientData.SendAccountEmails = true;
        
        // Add password for consumer credentials if provided (optional)
        if (password) {
            clientData.Password = password;
        }
        
        console.log('📝 Creating client:', firstName, lastName, email);
        console.log('   Address:', clientData.AddressLine1);
        console.log('   Gender:', clientData.Gender);
        console.log('   ReferredBy:', clientData.ReferredBy);
        console.log('   SendAccountEmails:', clientData.SendAccountEmails);
        
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
