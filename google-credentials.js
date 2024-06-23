module.exports = function (RED) {
    "use strict";

    const crypto = require("crypto");
    const { OAuth2Client } = require('google-auth-library');
    const url = require('url');

    function GoogleCredentialsNode(config) {
        RED.nodes.createNode(this, config);

        this.clientId = config.clientId;
        this.clientSecret = config.clientSecret;
        this.redirectUri = config.redirectUri;
        this.scopes = config.scopes || 'https://www.googleapis.com/auth/drive';

        console.log(`[google-credentials] Initializing node with ID: ${this.id}`);

        // Convert scopes to array if it's a string
        if (typeof this.scopes === 'string') {
            this.scopes = this.scopes.split(',');
        }

        // Initialize OAuth2Client instance
        this.oauth2Client = new OAuth2Client(this.clientId, this.clientSecret, this.redirectUri);

        // Method to get OAuth2 client instance, handling token refresh
        this.getClient = async function () {
            const credentials = RED.nodes.getCredentials(this.id);
            if (!credentials || !credentials.accessToken || !credentials.refreshToken) {
                const errorMessage = '[google-credentials] Missing credentials';
                this.error(errorMessage);
                console.error(`${errorMessage} for node ID: ${this.id}`);
                return null;
            }

            this.oauth2Client.setCredentials({
                access_token: credentials.accessToken,
                refresh_token: credentials.refreshToken,
            });

            // Check if access token needs to be refreshed
            if (credentials.expiryDate && Date.now() > credentials.expiryDate) {
                try {
                    console.log('[google-credentials] Refreshing access token...');
                    const tokens = await this.oauth2Client.getAccessToken();
                    credentials.accessToken = tokens.token;

                    // Update expiry date if available in the token response
                    if (tokens.res && tokens.res.data && tokens.res.data.expiry_date) {
                        credentials.expiryDate = tokens.res.data.expiry_date;
                    } else {
                        console.warn('[google-credentials] No valid expiry date found in the token response.');
                    }

                    RED.nodes.addCredentials(this.id, credentials);
                    this.oauth2Client.setCredentials(credentials);
                } catch (err) {
                    const errorMessage = `Error refreshing access token: ${err.message}`;
                    this.error(errorMessage);
                    console.error(`[google-credentials] ${errorMessage}`);
                }
            }

            return this.oauth2Client;
        };
    }

    RED.httpAdmin.get('/google-credentials/auth', function (req, res) {
        console.log('google-credentials/auth');
        if (!req.query.clientId || !req.query.clientSecret || !req.query.id || !req.query.callback) {
            res.status(400).send('Missing parameters');
            console.error(`[google-credentials] Missing parameters in /auth request`);
            return;
        }
        const node_id = req.query.id;
        const callback = req.query.callback;
        const credentials = {
            clientId: req.query.clientId,
            clientSecret: req.query.clientSecret,
            callback: callback,
        };
        const scopes = req.query.scopes || 'https://www.googleapis.com/auth/drive';

        const csrfToken = crypto.randomBytes(18).toString('base64').replace(/\//g, '-').replace(/\+/g, '_');
        credentials.csrfToken = csrfToken;
        res.cookie('csrf', csrfToken);

        // Extract dynamic base URL
        const parsedUrl = url.parse(callback);
        const basePath = parsedUrl.protocol + '//' + parsedUrl.host;

        res.redirect(url.format({
            protocol: 'https',
            hostname: 'accounts.google.com',
            pathname: '/o/oauth2/v2/auth',
            query: {
                access_type: 'offline',
                approval_prompt: 'force',
                scope: scopes,
                response_type: 'code',
                client_id: credentials.clientId,
                redirect_uri: basePath + '/google-credentials/auth/callback',
                state: node_id + ":" + csrfToken,
            }
        }));
        RED.nodes.addCredentials(node_id, credentials);
    });

    RED.httpAdmin.get('/google-credentials/auth/callback', async function (req, res) {
        console.log('google-credentials/auth/callback');
        if (req.query.error) {
            console.error(`[google-credentials] OAuth2 error: ${req.query.error_description}`);
            return res.send(`OAuth2 error: ${req.query.error_description}`);
        }
        const state = req.query.state.split(':');
        const node_id = state[0];
        const credentials = RED.nodes.getCredentials(node_id);
        if (!credentials || !credentials.clientId || !credentials.clientSecret) {
            const errorMessage = `[google-credentials] Missing credentials for node ID: ${node_id}`;
            console.error(errorMessage);
            return res.status(401).send("Missing credentials");
        }
        if (state[1] !== credentials.csrfToken) {
            const errorMessage = `[google-credentials] CSRF token mismatch for node ID: ${node_id}`;
            console.error(errorMessage);
            return res.status(401).send("CSRF token mismatch");
        }

        // Extract dynamic base URL
        const parsedUrl = url.parse(credentials.callback);
        const basePath = parsedUrl.protocol + '//' + parsedUrl.host;

        const oauth2Client = new OAuth2Client(
            credentials.clientId,
            credentials.clientSecret,
            basePath + '/google-credentials/auth/callback'
        );

        try {
            const { tokens } = await oauth2Client.getToken({
                code: req.query.code,
                redirect_uri: basePath + '/google-credentials/auth/callback'
            });

            credentials.accessToken = tokens.access_token;
            credentials.refreshToken = tokens.refresh_token;
            credentials.expiryDate = tokens.expiry_date;
            credentials.tokenType = tokens.token_type;

            delete credentials.csrfToken;
            delete credentials.callback;

            RED.nodes.addCredentials(node_id, credentials);
            res.send('Authorization successful. You can close this window.');
        } catch (error) {
            const errorMessage = `[google-credentials] Error exchanging code for tokens: ${error.message}`;
            console.error(errorMessage);
            return res.send('Could not receive tokens');
        }
    });

    RED.nodes.registerType("google-credentials", GoogleCredentialsNode, {
        credentials: {
            clientId: { type: "password" },
            clientSecret: { type: "password" },
            accessToken: { type: "password" },
            refreshToken: { type: "password" },
            expiryDate: { type: "password" }
        }
    });
};
