# External Links & Tool Stack — Extended Reference (Updated)

## External Resources (Auth-walled, can't fetch programmatically)

### Google Docs

| Document                       | URL                                                                             | Status                                                      |
| ------------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Main workflow doc (Kling 3.0)  | https://docs.google.com/document/d/1_U7aT7cNadhjRYKhW3_7so_KBWCgK7NyboRrrl8QfII | Linked                                                      |
| Universal UGC Master Prompt    | https://docs.google.com/document/d/1wB5hakXNqSj7N3_Ghga6C8TzYuP8QhVu4wyRfBdYJ5Y | PASTED (master/universal-ugc-master-prompt.md)              |
| Nano Banana Pro Prompt         | https://docs.google.com/document/d/1p0tMJvc5DNrSA--KXwmOmADGuF30NquF52vzG1Tb6uM | Linked, JSON template version pasted                        |
| ElevenLabs Voice Design Prompt | https://docs.google.com/document/d/1rgTmBOVa5o2Kw8nNeHFkSclm0xKBy_BrzDmsSZBNOUw | Linked, not pasted                                          |
| Kling o3 Gem Prompt            | https://docs.google.com/document/d/1sEHgVjFLl4yOsCRS-HtIgSA8WJZWzXNQxO7FldcZuus | Linked, not pasted                                          |
| UGC Deconstructor Gemini Gem   | https://docs.google.com/document/d/16umC4cAVyHtB3Q9y9toI3bjJXXbEqX7WQFn-Q3K9BQk | PASTED (sora/gemini-ugc-deconstructor-gem-system-prompt.md) |
| Claude UGC Project             | https://docs.google.com/document/d/1KRBiY8qRkoucIbpc8xEm8Xd1LxexuQqHI_btS9hBk2U | PASTED (sora/claude-sora-optimizer-project-instructions.md) |
| Gemini Copywriter Project      | https://docs.google.com/document/d/12S8V5jDhPJBggFcq2Hg-RGaKvCGYdgIo71_-dSj_Sbw | Linked, separate gem instructions pasted                    |

### Google Drive Folders

| Folder                                  | URL                                                                      | Contents                                                           |
| --------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Prompts folder (Claude chats reference) | https://drive.google.com/drive/folders/1jaoXfy2FMGOVHJTn1BOvC4iMS4cGpnFG | Reference Claude chats for Kling workflow                          |
| Kling o3 gem material                   | https://drive.google.com/drive/folders/1y9ArbIVwyg-jG7ce0IaMRODOXNNxNhB_ | Knowledge base for the Kling Gem                                   |
| Sora Knowledge Base                     | https://drive.google.com/drive/folders/1YzxJZMapDggYtjr_6wPpiKpQ01XJvoyA | Knowledge files for both Gemini Deconstructor AND Claude Optimizer |
| Gemini Copywriting Books                | https://drive.google.com/drive/folders/1UvcOVYFCeV1i8pcp7ptseavaPVPegbqQ | The 5 classic advertising books                                    |
| Gruns example results                   | https://drive.google.com/drive/folders/1uTDKjBxK5oSXZHNCul537vU-wMFFEdOu | Higgsfield workflow example                                        |
| Goli example results                    | https://drive.google.com/drive/folders/19oTF4KTrZLP_lw2j0iCzVQp66jygE5MO | Kie.ai workflow example                                            |
| All results with prompts                | https://drive.google.com/drive/folders/1Skjq7I7drgnhJUbWHPjgBBnGQfbcdL9g | Master library of past outputs                                     |

### Classic Advertising Books (referenced as knowledge for Copywriting Master gem)

- Great Leads
- Ogilvy on Advertising
- Reason Why Advertising
- Scientific Advertising (Claude Hopkins)
- Principles of Physiological Psychology (Wundt)

## Reference Video Sources

- Kalo Data (paid spy tool)
- Facebook Ads Library — https://facebook.com/ads/library
- TikTok — organic scroll
- AdSpy, Tyver.io — alternative spy tools

## Tools Used in Workflow

### Editing & Post

- CapCut — video editing, layering audio over video
- Adobe Podcast — voice enhancement

### Image Generation (First Frames)

- Nano Banana 2 / Pro — primary, via Gemini
- ChatGPT Images 2 — alternative

### Video Generation

- Kling 3.0 (primary for image-to-video with native audio + lip-sync)
  - Official: https://app.klingai.com/global/ (use self-referring mode for cheaper)
  - Alternative: https://kie.ai/
- Sora 2 — text-to-video, via the Gemini Deconstructor + Claude Optimizer pipeline
  - Use via Kie.ai (60% cheaper than OpenAI direct)
  - Use via Higgsfield
  - DO NOT use Freepik (character limit too small)
- Seedance 2.0 — older V3 workflow, deprecated by Kling 3.0
  - Via: kie.ai, Higgsfield, Mitte AI, Muapi AI

### Voice Generation

- ElevenLabs
  - Instant Voice Clone (preferred — clone from real video)
  - Voice Design (design from scratch with a prompt)

### Lip-Sync (Image-to-Video Talking Head, Alternative to Kling Native)

- Heygen Avatar IV — 1080p quality, simple workflow
- Hedra AI — https://www.hedra.com — $30/mo gets 13 minutes 720p
- Infinitetalk (open source) — via https://wavespeed.ai/models/wavespeed-ai/infinitetalk — $0.15/sec for 720p

## The Three Workflows We Now Support

### Workflow A: Kling 3.0 Image-to-Video (multi-clip ads, native lip-sync)

1. Master prompt → Claude/Gemini generates 16-clip storyboard with character/set/dialogue baked in
2. Nano Banana Pro → generates first-frame image for each clip
3. Kling 3.0 image-to-video → animates with native audio + lip-sync using [USE IMAGE X AS STARTING FRAME] + [GENERATE NATIVE AUDIO AND LIP-SYNC TO EXACT DIALOGUE]
4. CapCut → stitches clips together

### Workflow B: Sora 2 Text-to-Video (single-shot UGC replication)

1. Upload winning reference video to Gemini "UGC Deconstructor" Gem
2. Gemini outputs Sora-2 prompt (first pass, 95% there)
3. Paste into Claude "Sora Prompt Optimizer" project
4. Claude refines to pixel-perfect 5000-char Sora-2 prompt
5. Generate via Kie.ai or Higgsfield (NOT Freepik)

### Workflow C: Lip-Sync Alternative (image + voice → talking head)

1. Generate character image with Nano Banana Pro
2. Generate voice with ElevenLabs (clone or design)
3. Combine via Heygen Avatar IV / Hedra / Infinitetalk

### Separate: Copywriting Master Gem

1. Upload winning ad image OR video to "Copywriting Master" Gemini Gem
2. Gem analyzes psychological framework using classic advertising book knowledge
3. Outputs ad copy / video script applying same psychology to YOUR product

## Critical Pattern Observation

ALL workflows start from the same premise: Find a winning reference. Reverse-engineer it. Replicate at scale.

The bot's vision detection layer should reflect this. When a user uploads a winning ad, the system identifies the FORMAT and routes to the right replication workflow:

- Single-take talking head (5-15s) -> Sora 2 workflow OR Lip-sync (image + voice)
- Multi-scene narrative (60-90s, character speaks in multiple settings) -> Kling 3.0 multi-clip
- Pure cinematic / B-roll-driven -> Kling 3.0 cinematic-only

The format detection should drive the routing.
