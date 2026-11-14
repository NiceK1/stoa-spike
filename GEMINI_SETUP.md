# Gemini Integration Setup

## Changes Made

I've added full Gemini support to the app so you can compare it with Claude. Here's what was changed:

### 1. Environment Configuration (`.env`)
- Added `GEMINI_API_KEY` with your API key
- Set `VISION_PROVIDER=gemini-api` to use Gemini for analyzing floor plans
- Set `PLANNER_PROVIDER=gemini-api` to use Gemini for question planning
- Configured models:
  - `VISION_MODEL=gemini-4-hydrogen` - Latest Gemini 4 with full multimodal support
  - `PLANNER_MODEL=gemini-4-hydrogen` - Top-tier reasoning model

### 2. Package Dependencies (`app/package.json`)
- Added `"@google/generative-ai": "^0.21.0"` - the official Google Gemini SDK

### 3. Vision Model Implementation (`app/server/src/models/vision.ts`)
- Added `GeminiApiVision` class that implements the `VisionModel` interface
- Handles:
  - Image resizing and base64 encoding
  - JSON schema for structured outputs (strips unsupported fields like `additionalProperties`)
  - System instructions and prompts
  - Token counting and cost estimation
  - Response caching (same as other providers)
- Updated `createVision()` to support `"gemini-api"` provider
- Updated `createPlanner()` to support separate `PLANNER_PROVIDER` config
- Added Gemini pricing data

## How to Run

1. **Install the new dependency**:
   ```bash
   cd app
   npm install
   ```

2. **Build and start the server**:
   ```bash
   npm run build
   npm run server
   ```

3. **Open browser** to http://127.0.0.1:8787

## Switching Between Providers

To compare Gemini vs Claude, just change `VISION_PROVIDER` in `.env`:

### Use Gemini:
```bash
VISION_PROVIDER=gemini-api
GEMINI_API_KEY=--
```

### Use Anthropic API:
```bash
VISION_PROVIDER=anthropic-api
ANTHROPIC_API_KEY=sk-ant-usr-...
```

### Use Claude CLI (local):
```bash
VISION_PROVIDER=claude-cli
# No API key needed, uses local `claude` command
```

You can also mix and match - for example, use Gemini for vision and Claude for planning:
```bash
VISION_PROVIDER=gemini-api
PLANNER_PROVIDER=anthropic-api
```

## Available Models

Your API key has access to cutting-edge Gemini models including:

**Recommended for this app:**
- `gemini-4-hydrogen` - Latest Gemini 4 (1M token context, 65K output, thinking mode)
- `gemini-3.1-pro-preview` - Excellent reasoning (1M token context, thinking mode)
- `gemini-3-pro-image` - Specialized for image analysis (131K input, 32K output)
- `gemini-2.5-pro` - Stable, highly capable general model

**Other powerful options:**
- `gemini-4-carbon`, `gemini-4-argon` - Gemini 4 variants
- `gemini-3.8-flash`, `gemini-3.7-flash` - Fast inference models
- `gemini-pro-latest`, `gemini-flash-latest` - Auto-updated to latest stable

## Notes

- Response caching works the same way across all providers
- The Gemini implementation uses JSON schema mode for structured outputs (similar to Claude)
- Schema converter automatically strips unsupported fields like `additionalProperties`
- Cost tracking is built in
- The same image preprocessing is applied (resize to 2000px max dimension)

## Testing

Upload a floor plan and ask questions like:
- "How many doors are in this drawing?"
- "Count the windows"
- "What type of building is this?"

Compare the responses, speed, and accuracy between providers!
