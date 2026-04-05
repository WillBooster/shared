# Video Recording

Capture browser automation sessions as video for debugging, documentation, or verification. Produces WebM (VP8/VP9 codec).

## Basic Recording

```bash
# Start recording
bunx @playwright/cli@latest video-start

# Perform actions
bunx @playwright/cli@latest open https://example.com
bunx @playwright/cli@latest snapshot
bunx @playwright/cli@latest click e1
bunx @playwright/cli@latest fill e2 "test input"

# Stop and save
bunx @playwright/cli@latest video-stop demo.webm
```

## Best Practices

### 1. Use Descriptive Filenames

```bash
# Include context in filename
bunx @playwright/cli@latest video-stop recordings/login-flow-2024-01-15.webm
bunx @playwright/cli@latest video-stop recordings/checkout-test-run-42.webm
```

## Tracing vs Video

| Feature  | Video                | Tracing                                  |
| -------- | -------------------- | ---------------------------------------- |
| Output   | WebM file            | Trace file (viewable in Trace Viewer)    |
| Shows    | Visual recording     | DOM snapshots, network, console, actions |
| Use case | Demos, documentation | Debugging, analysis                      |
| Size     | Larger               | Smaller                                  |

## Limitations

- Recording adds slight overhead to automation
- Large recordings can consume significant disk space
