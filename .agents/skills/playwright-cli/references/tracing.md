# Tracing

Capture detailed execution traces for debugging and analysis. Traces include DOM snapshots, screenshots, network activity, and console logs.

## Basic Usage

```bash
# Start trace recording
bunx @playwright/cli@latest tracing-start

# Perform actions
bunx @playwright/cli@latest open https://example.com
bunx @playwright/cli@latest click e1
bunx @playwright/cli@latest fill e2 "test"

# Stop trace recording
bunx @playwright/cli@latest tracing-stop
```

## Trace Output Files

When you start tracing, Playwright creates a `traces/` directory with several files:

### `trace-{timestamp}.trace`

**Action log** - The main trace file containing:

- Every action performed (clicks, fills, navigations)
- DOM snapshots before and after each action
- Screenshots at each step
- Timing information
- Console messages
- Source locations

### `trace-{timestamp}.network`

**Network log** - Complete network activity:

- All HTTP requests and responses
- Request headers and bodies
- Response headers and bodies
- Timing (DNS, connect, TLS, TTFB, download)
- Resource sizes
- Failed requests and errors

### `resources/`

**Resources directory** - Cached resources:

- Images, fonts, stylesheets, scripts
- Response bodies for replay
- Assets needed to reconstruct page state

## What Traces Capture

| Category        | Details                                            |
| --------------- | -------------------------------------------------- |
| **Actions**     | Clicks, fills, hovers, keyboard input, navigations |
| **DOM**         | Full DOM snapshot before/after each action         |
| **Screenshots** | Visual state at each step                          |
| **Network**     | All requests, responses, headers, bodies, timing   |
| **Console**     | All console.log, warn, error messages              |
| **Timing**      | Precise timing for each operation                  |

## Use Cases

### Debugging Failed Actions

```bash
bunx @playwright/cli@latest tracing-start
bunx @playwright/cli@latest open https://app.example.com

# This click fails - why?
bunx @playwright/cli@latest click e5

bunx @playwright/cli@latest tracing-stop
# Open trace to see DOM state when click was attempted
```

### Analyzing Performance

```bash
bunx @playwright/cli@latest tracing-start
bunx @playwright/cli@latest open https://slow-site.com
bunx @playwright/cli@latest tracing-stop

# View network waterfall to identify slow resources
```

### Capturing Evidence

```bash
# Record a complete user flow for documentation
bunx @playwright/cli@latest tracing-start

bunx @playwright/cli@latest open https://app.example.com/checkout
bunx @playwright/cli@latest fill e1 "4111111111111111"
bunx @playwright/cli@latest fill e2 "12/25"
bunx @playwright/cli@latest fill e3 "123"
bunx @playwright/cli@latest click e4

bunx @playwright/cli@latest tracing-stop
# Trace shows exact sequence of events
```

## Trace vs Video vs Screenshot

| Feature                 | Trace       | Video       | Screenshot       |
| ----------------------- | ----------- | ----------- | ---------------- |
| **Format**              | .trace file | .webm video | .png/.jpeg image |
| **DOM inspection**      | Yes         | No          | No               |
| **Network details**     | Yes         | No          | No               |
| **Step-by-step replay** | Yes         | Continuous  | Single frame     |
| **File size**           | Medium      | Large       | Small            |
| **Best for**            | Debugging   | Demos       | Quick capture    |

## Best Practices

### 1. Start Tracing Before the Problem

```bash
# Trace the entire flow, not just the failing step
bunx @playwright/cli@latest tracing-start
bunx @playwright/cli@latest open https://example.com
# ... all steps leading to the issue ...
bunx @playwright/cli@latest tracing-stop
```

### 2. Clean Up Old Traces

Traces can consume significant disk space:

```bash
# Remove traces older than 7 days
find .playwright-cli/traces -mtime +7 -delete
```

## Limitations

- Traces add overhead to automation
- Large traces can consume significant disk space
- Some dynamic content may not replay perfectly
