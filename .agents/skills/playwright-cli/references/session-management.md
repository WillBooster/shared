# Browser Session Management

Run multiple isolated browser sessions concurrently with state persistence.

## Named Browser Sessions

Use `-s` flag to isolate browser contexts:

```bash
# Browser 1: Authentication flow
bunx @playwright/cli@latest -s=auth open https://app.example.com/login

# Browser 2: Public browsing (separate cookies, storage)
bunx @playwright/cli@latest -s=public open https://example.com

# Commands are isolated by browser session
bunx @playwright/cli@latest -s=auth fill e1 "user@example.com"
bunx @playwright/cli@latest -s=public snapshot
```

## Browser Session Isolation Properties

Each browser session has independent:

- Cookies
- LocalStorage / SessionStorage
- IndexedDB
- Cache
- Browsing history
- Open tabs

## Browser Session Commands

```bash
# List all browser sessions
bunx @playwright/cli@latest list

# Stop a browser session (close the browser)
bunx @playwright/cli@latest close                # stop the default browser
bunx @playwright/cli@latest -s=mysession close   # stop a named browser

# Stop all browser sessions
bunx @playwright/cli@latest close-all

# Forcefully kill all daemon processes (for stale/zombie processes)
bunx @playwright/cli@latest kill-all

# Delete browser session user data (profile directory)
bunx @playwright/cli@latest delete-data                # delete default browser data
bunx @playwright/cli@latest -s=mysession delete-data   # delete named browser data
```

## Environment Variable

Set a default browser session name via environment variable:

```bash
export PLAYWRIGHT_CLI_SESSION="mysession"
bunx @playwright/cli@latest open example.com  # Uses "mysession" automatically
```

## Common Patterns

### Concurrent Scraping

```bash
#!/bin/bash
# Scrape multiple sites concurrently

# Start all browsers
bunx @playwright/cli@latest -s=site1 open https://site1.com &
bunx @playwright/cli@latest -s=site2 open https://site2.com &
bunx @playwright/cli@latest -s=site3 open https://site3.com &
wait

# Take snapshots from each
bunx @playwright/cli@latest -s=site1 snapshot
bunx @playwright/cli@latest -s=site2 snapshot
bunx @playwright/cli@latest -s=site3 snapshot

# Cleanup
bunx @playwright/cli@latest close-all
```

### A/B Testing Sessions

```bash
# Test different user experiences
bunx @playwright/cli@latest -s=variant-a open "https://app.com?variant=a"
bunx @playwright/cli@latest -s=variant-b open "https://app.com?variant=b"

# Compare
bunx @playwright/cli@latest -s=variant-a screenshot
bunx @playwright/cli@latest -s=variant-b screenshot
```

### Persistent Profile

By default, browser profile is kept in memory only. Use `--persistent` flag on `open` to persist the browser profile to disk:

```bash
# Use persistent profile (auto-generated location)
bunx @playwright/cli@latest open https://example.com --persistent

# Use persistent profile with custom directory
bunx @playwright/cli@latest open https://example.com --profile=/path/to/profile
```

## Default Browser Session

When `-s` is omitted, commands use the default browser session:

```bash
# These use the same default browser session
bunx @playwright/cli@latest open https://example.com
bunx @playwright/cli@latest snapshot
bunx @playwright/cli@latest close  # Stops default browser
```

## Browser Session Configuration

Configure a browser session with specific settings when opening:

```bash
# Open with config file
bunx @playwright/cli@latest open https://example.com --config=.playwright/my-cli.json

# Open with specific browser
bunx @playwright/cli@latest open https://example.com --browser=firefox

# Open in headed mode
bunx @playwright/cli@latest open https://example.com --headed

# Open with persistent profile
bunx @playwright/cli@latest open https://example.com --persistent
```

## Best Practices

### 1. Name Browser Sessions Semantically

```bash
# GOOD: Clear purpose
bunx @playwright/cli@latest -s=github-auth open https://github.com
bunx @playwright/cli@latest -s=docs-scrape open https://docs.example.com

# AVOID: Generic names
bunx @playwright/cli@latest -s=s1 open https://github.com
```

### 2. Always Clean Up

```bash
# Stop browsers when done
bunx @playwright/cli@latest -s=auth close
bunx @playwright/cli@latest -s=scrape close

# Or stop all at once
bunx @playwright/cli@latest close-all

# If browsers become unresponsive or zombie processes remain
bunx @playwright/cli@latest kill-all
```

### 3. Delete Stale Browser Data

```bash
# Remove old browser data to free disk space
bunx @playwright/cli@latest -s=oldsession delete-data
```
