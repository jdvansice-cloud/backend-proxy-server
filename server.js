// Mimosa Spa Backend Proxy Server
// Connects to Mindbody Public API v6

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const MINDBODY_API_KEY = process.env.MINDBODY_API_KEY || 'e1acf5c4136e461991395b31edcb7cd7';
const MINDBODY_SITE_ID = process.env.MINDBODY_SITE_ID || '-99';
const MINDBODY_BASE_URL = 'https://api.mindbodyonline.com/public/v6';

// Middleware
app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Request logging
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// Helper function for Mindbody API calls
async function callMindbodyAPI(endpoint, method = 'GET', body = null, userToken = null) {
    const headers = {
        'Api-Key': MINDBODY_API_KEY,
        'SiteId': MINDBODY_SITE_ID,
        'Content-Type': 'application/json'
    };

    if (userToken) {
        headers['Authorization'] = userToken;
    }

    const options = {
        method,
        headers
    };

    if (body) {
        options.body = JSON.stringify(body);
    }

    console.log(`Mindbody API: ${method} ${endpoint}`);
    
    const response = await fetch(`${MINDBODY_BASE_URL}${endpoint}`, options);
    
    if (!response.ok) {
        const errorText = await response.text();
        console.error(`Mindbody API Error: ${response.status} - ${errorText}`);
        throw new Error(`Mindbody API returned ${response.status}`);
    }

    return await response.json();
}

// Root endpoint - Health check
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        service: 'Mimosa Spa Booking API',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        endpoints: {
            health: 'GET /',
            login: 'POST /api/auth/login',
            locations: 'GET /api/locations',
            sessionTypes: 'GET /api/session-types',
            staff: 'GET /api/staff',
            bookableItems: 'GET /api/bookable-items',
            book: 'POST /api/book',
            client: 'GET /api/client'
        }
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// 1. Authentication - Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({
                success: false,
                message: 'Username and password required'
            });
        }

        console.log('Login attempt:', username);

        const data = await callMindbodyAPI('/usertoken/issue', 'POST', {
            Username: username,
            Password: password
        });

        if (data.AccessToken) {
            console.log('Login successful');
            res.json({
                success: true,
                token: data.AccessToken,
                message: 'Login successful'
            });
        } else {
            res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// 1b. Register New Client
app.post('/api/auth/register', async (req, res) => {
    try {
        const { 
            firstName, 
            lastName, 
            email, 
            phone,
            birthDate,
            gender
        } = req.body;

        // Validate required fields
        if (!firstName || !lastName || !email) {
            return res.status(400).json({
                success: false,
                message: 'First name, last name, and email are required'
            });
        }

        console.log('Registering new client:', email);

        // Prepare client data for Mindbody
        const clientData = {
            FirstName: firstName,
            LastName: lastName,
            Email: email
        };

        // Add optional fields
        if (phone) clientData.MobilePhone = phone;
        if (birthDate) clientData.BirthDate = birthDate + 'T00:00:00';
        if (gender) clientData.Gender = gender;
        
        // Add default country for Panama
        clientData.Country = 'PA';

        console.log('Creating client with data:', clientData);

        // Create client in Mindbody
        const response = await callMindbodyAPI('/client/addclient', 'POST', clientData);

        if (response.Client) {
            console.log('Client registered successfully:', response.Client.Id);
            
            res.json({
                success: true,
                clientId: response.Client.Id,
                message: 'Registration successful! Please check your email for login instructions.',
                client: {
                    id: response.Client.Id,
                    name: `${response.Client.FirstName} ${response.Client.LastName}`,
                    email: response.Client.Email
                }
            });
        } else {
            throw new Error('Failed to create client account');
        }
    } catch (error) {
        console.error('Registration error:', error);
        
        // Check for duplicate email error
        const errorMessage = error.message.toLowerCase();
        if (errorMessage.includes('409') || errorMessage.includes('duplicate') || errorMessage.includes('already exists')) {
            res.status(409).json({
                success: false,
                message: 'An account with this email already exists. Please login instead.'
            });
        } else {
            res.status(500).json({
                success: false,
                message: error.message || 'Registration failed'
            });
        }
    }
});

// 2. Get Locations
app.get('/api/locations', async (req, res) => {
    try {
        console.log('Fetching locations...');
        const data = await callMindbodyAPI('/site/locations', 'GET');
        console.log('Locations fetched:', data.Locations?.length || 0);
        res.json(data);
    } catch (error) {
        console.error('Error fetching locations:', error);
        res.status(500).json({
            error: {
                message: error.message
            }
        });
    }
});

// 3. Get Session Types
app.get('/api/session-types', async (req, res) => {
    try {
        const userToken = req.headers.authorization;
        const locationId = req.query.locationId;

        let endpoint = '/site/sessiontypes';
        if (locationId) {
            endpoint += `?locationId=${locationId}`;
        }

        console.log('Fetching session types...');
        const data = await callMindbodyAPI(endpoint, 'GET', null, userToken);
        console.log('Session types fetched:', data.SessionTypes?.length || 0);
        res.json(data);
    } catch (error) {
        console.error('Error fetching session types:', error);
        res.status(500).json({
            error: {
                message: error.message
            }
        });
    }
});

// 4. Get Staff
app.get('/api/staff', async (req, res) => {
    try {
        const userToken = req.headers.authorization;
        console.log('Fetching staff...');
        const data = await callMindbodyAPI('/staff/staff', 'GET', null, userToken);
        console.log('Staff fetched:', data.StaffMembers?.length || 0);
        res.json(data);
    } catch (error) {
        console.error('Error fetching staff:', error);
        res.status(500).json({
            error: {
                message: error.message
            }
        });
    }
});

// 5. Get Bookable Items (Available Slots)
app.get('/api/bookable-items', async (req, res) => {
    try {
        const userToken = req.headers.authorization;
        const { sessionTypeIds, locationIds, staffIds, startDate, endDate } = req.query;

        const params = new URLSearchParams();
        if (sessionTypeIds) params.append('sessionTypeIds', sessionTypeIds);
        if (locationIds) params.append('locationIds', locationIds);
        if (staffIds) params.append('staffIds', staffIds);
        if (startDate) params.append('startDate', startDate);
        if (endDate) params.append('endDate', endDate);

        const endpoint = `/appointment/bookableitems?${params.toString()}`;
        
        console.log('Fetching bookable items:', params.toString());
        const data = await callMindbodyAPI(endpoint, 'GET', null, userToken);
        console.log('Bookable items fetched:', data.ScheduleItems?.length || 0);
        res.json(data);
    } catch (error) {
        console.error('Error fetching bookable items:', error);
        res.status(500).json({
            error: {
                message: error.message
            }
        });
    }
});

// 6. Book Appointment
app.post('/api/book', async (req, res) => {
    try {
        const userToken = req.headers.authorization;
        const bookingData = req.body;

        console.log('Creating appointment:', JSON.stringify(bookingData, null, 2));

        const data = await callMindbodyAPI(
            '/appointment/addappointment',
            'POST',
            bookingData,
            userToken
        );

        console.log('Appointment created successfully');
        res.json({
            success: true,
            ...data
        });
    } catch (error) {
        console.error('Error creating appointment:', error);
        res.status(500).json({
            success: false,
            error: {
                message: error.message
            }
        });
    }
});

// 7. Get Client Info
app.get('/api/client', async (req, res) => {
    try {
        const userToken = req.headers.authorization;
        const username = req.query.username;

        let endpoint = '/client/clients';
        if (username) {
            endpoint += `?searchText=${encodeURIComponent(username)}`;
        }

        console.log('Fetching client info...');
        const data = await callMindbodyAPI(endpoint, 'GET', null, userToken);
        console.log('Client info fetched');
        res.json(data);
    } catch (error) {
        console.error('Error fetching client:', error);
        res.status(500).json({
            error: {
                message: error.message
            }
        });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({
        error: {
            message: 'Internal server error',
            details: err.message
        }
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: {
            message: 'Endpoint not found',
            path: req.path
        }
    });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log('\n' + '='.repeat(50));
    console.log('🚀 MIMOSA SPA BOOKING API SERVER');
    console.log('='.repeat(50));
    console.log(`📡 Server running on port ${PORT}`);
    console.log(`🔑 API Key: ${MINDBODY_API_KEY.substring(0, 10)}...`);
    console.log(`🏢 Site ID: ${MINDBODY_SITE_ID}`);
    console.log(`⏰ Started: ${new Date().toISOString()}`);
    console.log('='.repeat(50) + '\n');
});

module.exports = app;
