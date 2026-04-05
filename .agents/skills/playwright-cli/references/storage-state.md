# Storage Management

Manage cookies, localStorage, sessionStorage, and browser storage state.

## Storage State

Save and restore complete browser state including cookies and storage.

### Save Storage State

```bash
# Save to auto-generated filename (storage-state-{timestamp}.json)
bunx @playwright/cli@latest state-save

# Save to specific filename
bunx @playwright/cli@latest state-save my-auth-state.json
```

### Restore Storage State

```bash
# Load storage state from file
bunx @playwright/cli@latest state-load my-auth-state.json

# Reload page to apply cookies
bunx @playwright/cli@latest open https://example.com
```

### Storage State File Format

The saved file contains:

```json
{
  "cookies": [
    {
      "name": "session_id",
      "value": "abc123",
      "domain": "example.com",
      "path": "/",
      "expires": 1735689600,
      "httpOnly": true,
      "secure": true,
      "sameSite": "Lax"
    }
  ],
  "origins": [
    {
      "origin": "https://example.com",
      "localStorage": [
        { "name": "theme", "value": "dark" },
        { "name": "user_id", "value": "12345" }
      ]
    }
  ]
}
```

## Cookies

### List All Cookies

```bash
bunx @playwright/cli@latest cookie-list
```

### Filter Cookies by Domain

```bash
bunx @playwright/cli@latest cookie-list --domain=example.com
```

### Filter Cookies by Path

```bash
bunx @playwright/cli@latest cookie-list --path=/api
```

### Get Specific Cookie

```bash
bunx @playwright/cli@latest cookie-get session_id
```

### Set a Cookie

```bash
# Basic cookie
bunx @playwright/cli@latest cookie-set session abc123

# Cookie with options
bunx @playwright/cli@latest cookie-set session abc123 --domain=example.com --path=/ --httpOnly --secure --sameSite=Lax

# Cookie with expiration (Unix timestamp)
bunx @playwright/cli@latest cookie-set remember_me token123 --expires=1735689600
```

### Delete a Cookie

```bash
bunx @playwright/cli@latest cookie-delete session_id
```

### Clear All Cookies

```bash
bunx @playwright/cli@latest cookie-clear
```

### Advanced: Multiple Cookies or Custom Options

For complex scenarios like adding multiple cookies at once, use `run-code`:

```bash
bunx @playwright/cli@latest run-code "async page => {
  await page.context().addCookies([
    { name: 'session_id', value: 'sess_abc123', domain: 'example.com', path: '/', httpOnly: true },
    { name: 'preferences', value: JSON.stringify({ theme: 'dark' }), domain: 'example.com', path: '/' }
  ]);
}"
```

## Local Storage

### List All localStorage Items

```bash
bunx @playwright/cli@latest localstorage-list
```

### Get Single Value

```bash
bunx @playwright/cli@latest localstorage-get token
```

### Set Value

```bash
bunx @playwright/cli@latest localstorage-set theme dark
```

### Set JSON Value

```bash
bunx @playwright/cli@latest localstorage-set user_settings '{"theme":"dark","language":"en"}'
```

### Delete Single Item

```bash
bunx @playwright/cli@latest localstorage-delete token
```

### Clear All localStorage

```bash
bunx @playwright/cli@latest localstorage-clear
```

### Advanced: Multiple Operations

For complex scenarios like setting multiple values at once, use `run-code`:

```bash
bunx @playwright/cli@latest run-code "async page => {
  await page.evaluate(() => {
    localStorage.setItem('token', 'jwt_abc123');
    localStorage.setItem('user_id', '12345');
    localStorage.setItem('expires_at', Date.now() + 3600000);
  });
}"
```

## Session Storage

### List All sessionStorage Items

```bash
bunx @playwright/cli@latest sessionstorage-list
```

### Get Single Value

```bash
bunx @playwright/cli@latest sessionstorage-get form_data
```

### Set Value

```bash
bunx @playwright/cli@latest sessionstorage-set step 3
```

### Delete Single Item

```bash
bunx @playwright/cli@latest sessionstorage-delete step
```

### Clear sessionStorage

```bash
bunx @playwright/cli@latest sessionstorage-clear
```

## IndexedDB

### List Databases

```bash
bunx @playwright/cli@latest run-code "async page => {
  return await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    return databases;
  });
}"
```

### Delete Database

```bash
bunx @playwright/cli@latest run-code "async page => {
  await page.evaluate(() => {
    indexedDB.deleteDatabase('myDatabase');
  });
}"
```

## Common Patterns

### Authentication State Reuse

```bash
# Step 1: Login and save state
bunx @playwright/cli@latest open https://app.example.com/login
bunx @playwright/cli@latest snapshot
bunx @playwright/cli@latest fill e1 "user@example.com"
bunx @playwright/cli@latest fill e2 "password123"
bunx @playwright/cli@latest click e3

# Save the authenticated state
bunx @playwright/cli@latest state-save auth.json

# Step 2: Later, restore state and skip login
bunx @playwright/cli@latest state-load auth.json
bunx @playwright/cli@latest open https://app.example.com/dashboard
# Already logged in!
```

### Save and Restore Roundtrip

```bash
# Set up authentication state
bunx @playwright/cli@latest open https://example.com
bunx @playwright/cli@latest eval "() => { document.cookie = 'session=abc123'; localStorage.setItem('user', 'john'); }"

# Save state to file
bunx @playwright/cli@latest state-save my-session.json

# ... later, in a new session ...

# Restore state
bunx @playwright/cli@latest state-load my-session.json
bunx @playwright/cli@latest open https://example.com
# Cookies and localStorage are restored!
```

## Security Notes

- Never commit storage state files containing auth tokens
- Add `*.auth-state.json` to `.gitignore`
- Delete state files after automation completes
- Use environment variables for sensitive data
- By default, sessions run in-memory mode which is safer for sensitive operations
