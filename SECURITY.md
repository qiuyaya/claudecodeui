# Security Policy

## Supported Versions

Currently maintained versions and their security update status:

| Version | Support Status |
| --- | --- |
| 1.16.x | ✅ Supported |
| < 1.16 | ❌ Not Supported |

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it through the following channels:

1. **DO NOT** create a public GitHub Issue
2. Report privately through GitHub Security Advisories: https://github.com/siteboon/claudecodeui/security/advisories
3. Include the following information:
   - Detailed vulnerability description
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if available)

We will acknowledge receipt within 48 hours and provide an initial assessment within 7 days.

## Security Configuration Checklist

### Required Configuration ✅

Before deploying to production, you **MUST** complete the following configurations:

- [ ] Set a strong random `JWT_SECRET` (minimum 32 characters)
- [ ] Configure `ALLOWED_ORIGINS` to your domain name(s)
- [ ] Set `NODE_ENV=production`
- [ ] Configure HTTPS (or use a reverse proxy)
- [ ] Change the default database path (optional but recommended)

### Recommended Configuration 📋

- [ ] Enable `FORCE_HTTPS=true`
- [ ] Configure `TRUSTED_PROXIES` (if using a proxy)
- [ ] Set `MAX_CONNECTIONS` to limit concurrency
- [ ] Regular database backups
- [ ] Configure log rotation

### Generating Secure Keys

```bash
# Generate JWT Secret
openssl rand -base64 32

# Or use Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Security Best Practices

### 1. Network Security

- Use HTTPS in production
- Use a reverse proxy (Nginx/Apache)
- Configure firewall to only open necessary ports
- Enable fail2ban to prevent brute force attacks

### 2. Access Control

- Use strong passwords (at least 12 characters)
- Regularly rotate API keys
- Limit database file access permissions (600)
- Do not run the application as root user

### 3. Monitoring and Auditing

- Regularly check security logs (`logs/security.log`)
- Monitor abnormal login attempts
- Set up disk space alerts
- Regularly review API key usage

### 4. Updates and Maintenance

- Keep dependencies up to date (`npm audit fix`)
- Subscribe to security announcements
- Regular data backups

## Known Limitations

1. **Single User System**: Current version only supports single user, not suitable for multi-tenant scenarios
2. **Token Storage**: Refresh tokens are stored in SQLite; for high-concurrency scenarios, consider using Redis
3. **File System Access**: Application has full file system access; strictly limit the user permissions under which it runs

## Security Features

### Authentication and Authorization

- **JWT-based Authentication**: Secure token-based authentication with configurable expiration
- **Refresh Token System**: Long-lived refresh tokens for seamless re-authentication
- **bcrypt Password Hashing**: Industry-standard password hashing with salt
- **Rate Limiting**: Protection against brute force attacks on authentication endpoints

### API Security

- **CORS Configuration**: Strict cross-origin resource sharing policies
- **Request Rate Limiting**: Per-IP rate limiting for API endpoints
- **Request Size Limits**: Protection against oversized payload attacks
- **Concurrent Connection Limits**: Prevention of resource exhaustion

### Command Execution Security

- **Command Allowlist**: Only whitelisted commands can be executed
- **Argument Validation**: Strict validation of command arguments
- **Path Traversal Protection**: Enhanced checks to prevent directory traversal
- **Dangerous Character Detection**: Blocks shell injection attempts

### WebSocket Security

- **Subprotocol Authentication**: Tokens passed securely via subprotocol, not URL
- **Connection Rate Limiting**: Limits on WebSocket connection attempts
- **Origin Validation**: WebSocket connections validated against allowed origins

### Network Security

- **HTTPS Enforcement**: Automatic HTTP to HTTPS redirect in production
- **Security Headers**: Comprehensive security headers via Helmet
  - Content Security Policy (CSP)
  - HTTP Strict Transport Security (HSTS)
  - X-Frame-Options
  - X-Content-Type-Options
  - Referrer-Policy
  - Permissions-Policy

### Platform Mode (Multi-tenancy)

- **Proxy Authentication**: Trusted proxy validation for managed deployments
- **Identity Header Validation**: Required proxy headers for user identification
- **Audit Logging**: Complete audit trail for platform operations

### Error Handling and Logging

- **Error Sanitization**: Prevents information leakage in error messages
- **Structured Logging**: Security events, audit logs, and application logs
- **Log Rotation**: Automatic rotation when logs exceed size limits
- **Sensitive Data Redaction**: Passwords, tokens, and keys are redacted from logs

## Security Update History

### Version 1.17.0 (Planned)
- ✅ Mandatory JWT_SECRET configuration
- ✅ Token expiration mechanism
- ✅ CORS security policy
- ✅ Rate limiting
- ✅ Enhanced WebSocket authentication
- ✅ Command execution security improvements
- ✅ Request size and concurrency limits
- ✅ HTTPS and security headers
- ✅ Platform mode security
- ✅ Error handling and logging improvements

### Version 1.16.0
- Basic authentication system
- bcrypt password hashing
- Command execution allowlist

## Deployment Security

### Production Deployment Checklist

1. **Environment Variables**
   ```bash
   # Generate and set JWT secret
   JWT_SECRET=$(openssl rand -base64 32)

   # Set production environment
   NODE_ENV=production

   # Configure CORS
   ALLOWED_ORIGINS=https://yourdomain.com

   # Enable HTTPS
   FORCE_HTTPS=true
   ```

2. **File Permissions**
   ```bash
   # Secure database file
   chmod 600 /path/to/auth.db

   # Secure log directory
   chmod 700 /path/to/logs
   chmod 600 /path/to/logs/*.log

   # Secure .env file
   chmod 600 .env
   ```

3. **Reverse Proxy Configuration**

   Example Nginx configuration:
   ```nginx
   server {
       listen 443 ssl http2;
       server_name yourdomain.com;

       ssl_certificate /path/to/cert.pem;
       ssl_certificate_key /path/to/key.pem;

       # Security headers
       add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

       location / {
           proxy_pass http://localhost:3001;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection "upgrade";
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
   }
   ```

4. **System Hardening**
   - Run as non-root user
   - Use systemd service with restricted permissions
   - Enable firewall (ufw/iptables)
   - Install and configure fail2ban

### Docker Security

If deploying with Docker:

```dockerfile
# Use non-root user
FROM node:18-alpine
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001
USER nodejs

# Set production environment
ENV NODE_ENV=production
```

Mount secrets as read-only in `docker-compose.yml`:

```yaml
services:
  app:
    volumes:
      - ./.env:/app/.env:ro
```

## Incident Response

If you believe your deployment has been compromised:

1. **Immediate Actions**
   - Rotate all JWT secrets immediately
   - Revoke all active tokens
   - Review security logs for suspicious activity
   - Change all user passwords

2. **Investigation**
   - Check `logs/security.log` for unauthorized access attempts
   - Review `logs/audit.log` for suspicious actions
   - Examine system logs for anomalies

3. **Recovery**
   - Patch any identified vulnerabilities
   - Restore from backup if necessary
   - Monitor for continued suspicious activity

4. **Reporting**
   - Document the incident
   - Report to the security team
   - Consider notifying affected users

## Contact

- Security Issues: Use GitHub Security Advisories
- General Support: https://github.com/siteboon/claudecodeui/issues
- Project Repository: https://github.com/siteboon/claudecodeui

## Acknowledgments

We thank the security researchers and users who responsibly disclose vulnerabilities to help make this project more secure.
