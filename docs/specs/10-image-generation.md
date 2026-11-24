# Image generation: a tool any chat model can call

Ask for a picture in a chat ("draw a lighthouse at dusk, as a watercolour") and the
assistant calls the built-in tool `generate_image`. The tool sends the prompt to an
image model through its provider's API, saves the pictures in the workspace and shows
them under the answer. The tool is ordinary tool calling, so the chat model itself does
not have to make images: Claude, a local Llama or GPT can all use it. Only the image
model, chosen in Settings, makes the pictures.

Written before the code (November 2026). The request shapes were checked against the
providers' documentation in that month (see "Providers" below).

## How you use it

- Configure an image model (below) and ask for an image in Chat or Agent mode.
- The pictures appear under the answer, like files the agent attaches: click one to see
  it full size; each has a download button and an **Open in Files** link to the saved copy
  in the workspace.
- In Agent mode, the activity list shows the call: the prompt, the model, the saved paths.
- To change an image ("make the sky darker"), the assistant passes the saved file back as
  an input image, if the image model can edit (OpenAI and OpenRouter models can; Google's
  OpenAI-compatible endpoint can't, see below).
- The assistant can hand the file on: `attach_file`, a document, an e-mail, and so on.

## Setting it up

1. **Settings → Providers & Models**: add (or reuse) a provider that has image models:
   - **OpenAI** (your API key): add the model `gpt-image-1.5` or `gpt-image-2`
     (`gpt-image-1` was shut down in October 2026).
   - **OpenRouter** (your API key): add an image model, e.g. `google/gemini-2.5-flash-image`
     (OpenRouter's model list marks image models; "Discover" finds them).
   - **Google Gemini** (new provider type; an API key from Google AI Studio): add
     `gemini-2.5-flash-image` or `gemini-3-pro-image-preview`. The same provider also
     gives you Gemini chat models.
   - **OpenAI-compatible** servers that offer `/images/generations` (LocalAI, a self-hosted
     gateway, …) work too.
   A model is recognised as an image model by name (`gpt-image`, `dall-e`, `-image`,
   `imagen`, `flux`, `stable-diffusion`, …) or by OpenRouter's model list, and gets the
   new capability **Image generation**; you can switch it on or off per model.
2. **Default models → Image generation**: pick the model. Like Embeddings and
   Transcription, this task never falls back to the chat model. Unset: the tool tells the
   assistant (and so you) exactly this.
3. **Image generation** card on the same page: how many pictures one call may make
   (default 4, at most 10), the largest resolution (default 2K), and whether automations
   must ask first (default yes).
4. **Settings → Agent Permissions → Generate images**: default *Fully autonomous* (an
   interactive chat makes pictures without asking). Set it to *Always ask* to approve each
   call, or *Never* to switch the tool off.

## The tool

```
generate_image(
  prompt: str (1–4,000 chars, required),
  aspect_ratio: "1:1" | "4:3" | "3:4" | "3:2" | "2:3" | "16:9" | "9:16" = "1:1",
  count: int 1–10 = 1,               # clamped to the setting (default 4)
  quality: "auto" | "low" | "medium" | "high" = "auto",
  resolution: "1K" | "2K" | "4K" = "1K",   # clamped to the setting (default 2K)
  input_images: list[str] (≤ 8 workspace paths) = [],   # edit / vary these
  path: str | None = None,           # a folder, or a file name (".png" etc.)
  model: str | None = None,          # one of the configured image models
)
```

- **Result for the model**: the saved path(s), the model used, the size, and the
  provider's revised prompt or text if it gave one. The images themselves are not sent
  back to the chat model (it would pay to look at its own picture; it can `read_file`
  one if it needs to).
- **Result for the UI** (`ToolResult.data`): `images: [{path, attachment_id, width,
  height}]`, `model`, `prompt`.
- **Where files go**: `path` when given (a folder, or a file name: `-2`, `-3`, … are added
  for more than one image). Otherwise `files/generated/<date>/<slug>-<n>.<ext>`, or
  `projects/<project>/generated/<date>/…` in a project's chat. `<slug>` comes from the
  prompt; an existing name is never overwritten (`-2`, `-3`, …). The date is in the
  user's time zone.
- **Provenance**: next to each picture a sidecar `<file>.json`:
  `{prompt, revised_prompt, model, provider, size, aspect_ratio, quality, input_images,
  created_at, chat_id, run_id, made_by}` (`made_by` is the actor reference, e.g.
  `chat:<id>`). Workspace writes are recorded in the run's history like other file tools.
- **Model override**: `model` is matched against the enabled models with the
  *Image generation* capability (model id, key or display name). Anything else is an
  error that lists the configured ones, so the model can never reach an arbitrary model.
- **No image model**: the tool is still offered, and answers with an error the assistant
  passes on: "No image model is set up. Add a provider with an image model (OpenAI
  gpt-image-1.5, OpenRouter, Google Gemini) in Settings → Providers & Models and choose it
  under Default models → Image generation."

## Where it is offered

- **Agent mode**: like any tool, when "Generate images" is not *Never*.
- **Chat mode**: chat mode has no approval step, so (like the memory tools) the tool is
  offered only when its permission allows it without asking. A chat turn uses the tool
  loop when memory is on *or* an image model is set, and the chat model supports tools.
  Otherwise chat stays one plain model call (no tool).
- **Automations** (and their sub-agents): offered, but each call asks first (the run waits
  and you are notified, per the automation's "when approval is needed" setting) unless you
  switch "Automations ask before generating images" off. This is a rule added to the
  run's policy snapshot, so it only ever makes a call stricter: *Never* stays *Never*.

## Safety and cost

- **Keys** stay encrypted secrets (`features/secrets`); the image client gets them from
  the provider row like the chat adapters, and they never reach the model, a tool result
  or a log line.
- **Caps per call**: `count` ≤ setting (≤ 10 hard), resolution ≤ setting, ≤ 8 input
  images, each input image ≤ 30 MB and decoded with Pillow's limits (and scaled down to
  1,568 px on the long side before upload, as images for chat models are), prompt ≤ 4,000 characters. The run's own limits
  (tool calls, time, cost) apply as for every tool.
- **Cost**: each call writes a usage record (`request_kind="image"`) with the provider's
  reported cost (OpenRouter) or an estimate from the model's per-token prices (OpenAI
  reports image tokens). The tool result says how many images were made.
- **Errors are tool results**, never crashes: a content-policy refusal ("The image model
  refused this prompt: …"), a bad key, no credits, a timeout, a model that cannot edit,
  or a response without images each come back as `is_error=True` with a readable message.
- **Downloads**: a provider that answers with a URL instead of image bytes is fetched
  through `web/safe_http.py` (no private addresses unless allowed in Settings → Web &
  Search), at most 25 MB per image, 30 s; only `image/png`, `image/jpeg`, `image/webp` and
  `image/gif` content whose bytes Pillow recognises as that kind of image is saved.
  Base64 images are checked the same way. Nothing else is written to the workspace.
- **Shown safely**: the picture is shown from Anemo itself (`/api/attachments/…`), never
  from the provider's URL, so the page loads nothing from another site.

## Providers

One small client per API shape, in `providers/images.py`; it knows nothing of runs or
tools. Which shape a provider uses depends on its type:

| Provider type | Endpoint | Notes |
|---|---|---|
| `openai`, `openai_compatible` | `POST {base}/images/generations` (JSON: `model, prompt, n, size, quality`); with input images `POST {base}/images/edits` (multipart, `image[]` per file) | GPT image models always answer with `data[].b64_json`; `url` is handled for other servers. The aspect ratio becomes the nearest of `1024x1024`, `1536x1024`, `1024x1536`. Refusal: `error.code = "moderation_blocked"`. |
| `openrouter` | `POST {base}/images` (JSON: `model, prompt, n, aspect_ratio, resolution, quality, response_format: "b64_json", input_references[]`) | Input images as `data:` URLs. `usage.cost` is the real cost. |
| `google` | `POST {base}/images/generations` on Gemini's OpenAI-compatible endpoint (`…/v1beta/openai`; JSON: `model, prompt, n, response_format: "b64_json", aspect_ratio`) | No edits on that endpoint: input images give a clear error. Imagen is shut down; Gemini image models (`gemini-2.5-flash-image`, `gemini-3-pro-image-preview`) are used. |
| `anthropic`, `claude_code`, `fake` | none | Not image providers. (The fake provider gets a test image generator for e2e only.) |

Errors map to one `ImageError(message, refused: bool)`: HTTP 400 with a moderation or
safety code becomes "refused"; 401/403 "check the API key"; 402 "no credits"; 429/5xx
"try again later".

## Design

**Backend**
- `providers/images.py`: `ImageRequest`, `ImageResult`, `ImageError`, `generate(cfg,
  request)` that picks the client by provider type; `transport_override` for tests.
- `providers/catalog.py`: `image_generation` capability guessed by name (`chat`,
  `streaming`, `tools` off for those). OpenRouter discovery also reads
  `architecture.output_modalities`.
- `providers/registry.py`: provider type `google` (Gemini through its OpenAI-compatible
  endpoint; the chat adapter is the OpenAI one).
- `features/settings/sections.py`: `ModelDefaults.image`, task `image`; section `images`
  (`ImageSettings`: `max_count`, `max_resolution`, `ask_in_automations`), security-sensitive
  like the permissions (it decides what may be spent without asking).
- `providers/router.py`: `image` joins the tasks that need their own kind of model.
- `features/image_generation/service.py`: choose the model (default or override), call
  the client, check and download images, save them with their sidecars, record usage;
  `automation_rule()` for the policy snapshot.
- `tools/builtin/images.py`: the `GenerateImage` tool (capability `image.generate`).
- `policy/presets.py`: category `image.generate` "Generate images", default autonomous.
- `tools/registry.py`: the tool in `BUILTIN_TOOLS`; offered in chat mode too (when allowed
  without asking).
- `runtime/dispatch.py`: a chat turn uses the tool loop when an image model is set.
- `runtime/agent_snapshot.py`: the "automations ask" rule.
- `attachments.workspace_path` (new nullable column, migration): the workspace file an
  answer's attachment is a copy of, so the chat can link to it (`AttachmentSummary.path`).
- `features/providers/service.py`: "Test" on an image model does not generate (it would
  cost money); it says so.

**Frontend**
- Settings → Providers & Models: the *Image generation* default, the capability switch and
  chip, and the *Image generation* card (count, resolution, automations ask).
- Chat: `AnswerFiles` shows an **Open in Files** link for an attachment with a `path`.
- Agent activity: a `generate_image` call shows its pictures (zoomable) and the paths.
- Ukrainian and Russian translations for every new text.

## Tests

- Unit (`tests/unit/test_image_providers.py`): the request each client builds (URL,
  headers, JSON or multipart body) for OpenAI generate and edit, OpenRouter, Google; the
  size mapping; parsing `b64_json` and `url` answers; refusals and HTTP errors mapped to
  readable messages; capability guessing.
- API (`tests/api/test_image_generation.py`, mocked HTTP, no real keys): the agent
  generates, files and sidecars land in the right folder (project chat too), images are
  attached to the answer with their path, usage is recorded, caps clamp, a bad override and
  no model give readable errors, a refusal is a tool error, a URL answer is downloaded only
  when it is an image, input images are sent, chat mode offers the tool only when allowed
  without asking, automations ask, the key never appears in what the model saw.

## Not in this version

- Masks / inpainting, transparent backgrounds, streaming partial images.
- A picker in the message box for the image model (the default and the tool's `model`
  argument cover it).
- Google's native Interactions API (the OpenAI-compatible endpoint is used instead), so
  no image editing with Google models yet.
