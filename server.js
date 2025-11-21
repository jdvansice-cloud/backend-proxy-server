// Simple Backend Proxy for Mindbody API
// Deploy to Railway, Render, or any Node.js hosting

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Allow your Netlify domain
app.use(cors({
    origin: '*', // Open for testing - restrict in production
    credentials: true
}));

app.use(express.json());

// Mindbody Config
const API_KEY = 'e1acf5c4136e461991395b31edcb7cd7';
const SITE_ID = '-99';
const BASE_URL = 'https://api.mindbodyonline.com/public/v6';

// Health check
app.get('/', (req, res) => {
    res.json({ 
        status: 'OK', 
        message: 'Mimosa Spa Booking Proxy Server',
        endpoints: [
            'POST /api/auth/login',
            'GET /api/locations',
            'GET /api/services',
            'GET /api/staff',
            'POST /api/book'
        ]
    });
});

// Login endpoint
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        const response = await axios.post(
            `${BASE_URL}/usertoken/issue`,
            {
                Username: username,
                Password: password
            },
            {
                headers: {
                    'Api-Key': API_KEY,
                    'SiteId': SITE_ID,
                    'Content-Type': 'application/json'
                }
            }
        );

        res.json({
            success: true,
            token: response.data.AccessToken
        });

    } catch (error) {
        console.error('Login error:', error.response?.data || error.message);
        res.status(401).json({
            success: false,
            message: error.response?.data?.Error?.Message || 'Authentication failed'
        });
    }
});

// Get client info
app.get('/api/client', async (req, res) => {
    try {
        const { username } = req.query;
        const authToken = req.headers.authorization;

        const response = await axios.get(
            `${BASE_URL}/client/clients?searchText=${username}`,
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

// Get locations
app.get('/api/locations', async (req, res) => {
    try {
        const response = await axios.get(
            `${BASE_URL}/site/locations`,
            {
                headers: {
                    'Api-Key': API_KEY,
                    'SiteId': SITE_ID
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

// Get services
app.get('/api/services', async (req, res) => {
    try {
        const { locationId } = req.query;
        const authToken = req.headers.authorization;

        const response = await axios.get(
            `${BASE_URL}/site/services${locationId ? `?locationId=${locationId}` : ''}`,
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

// Get session types (alternative to services in some sandboxes)
app.get('/api/session-types', async (req, res) => {
    try {
        const { locationId } = req.query;
        const authToken = req.headers.authorization;

        const response = await axios.get(
            `${BASE_URL}/site/sessiontypes${locationId ? `?locationId=${locationId}` : ''}`,
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

// Get staff
app.get('/api/staff', async (req, res) => {
    try {
        const authToken = req.headers.authorization;

        const response = await axios.get(
            `${BASE_URL}/staff/staff`,
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

// Get bookable items
app.get('/api/bookable-items', async (req, res) => {
    try {
        const authToken = req.headers.authorization;
        const queryString = new URLSearchParams(req.query).toString();

        const response = await axios.get(
            `${BASE_URL}/appointment/bookableitems?${queryString}`,
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

// Book appointment
app.post('/api/book', async (req, res) => {
    try {
        const authToken = req.headers.authorization;

        const response = await axios.post(
            `${BASE_URL}/appointment/addappointment`,
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

// Start server
app.listen(PORT, () => {
    console.log(`✅ Mimosa Spa Proxy Server running on port ${PORT}`);
    console.log(`✅ Environment: ${process.env.NODE_ENV || 'development'}`);
});
