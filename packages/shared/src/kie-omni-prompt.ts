/**
 * Polish-12: hard guardrail block prepended to every Gemini Omni Flash
 * prompt submitted to kie.ai.
 *
 * Omni Flash has no `negative_prompt` parameter — the only lever is
 * the positive prompt. So we bake the entire negative directive
 * (no captions, no b-roll, no studio lighting, no plastic skin) into
 * a prefix block.
 *
 * Polish-11.2's IMAGE_UGC_HARD_DIRECTIVE covers the Nano Banana
 * reference frame. This one covers the video model.
 */
export const KIE_OMNI_FLASH_HARD_DIRECTIVE = `ABSOLUTE REQUIREMENTS (these override any other instruction):
- This is an AMATEUR SMARTPHONE SELFIE VIDEO. Vertical 9:16. Slightly handheld, natural camera micro-movement. Pores visible. No makeup or minimal makeup. Real lighting (natural window light or basic indoor lighting), not studio.
- This clip is a SEGMENT of a longer continuous video. The character is mid-speech when the clip ends — the next segment picks up the next moment. NO ending gesture, NO closing beat, NO final smile. Treat the final frame as a HARD CUT mid-action.
- ABSOLUTELY NO: captions, subtitles, closed captions, on-screen text, burned-in text, watermarks, logos, text overlays, lower thirds, brand graphics, b-roll inserts, multi-shot composites, split-screen, picture-in-picture.
- ABSOLUTELY NO: end-of-clip pause, smile-to-camera, "look at camera" beat, idle reaction frame, or any cinematic ending gesture. The clip cuts on the character mid-speech / mid-action, NOT on a final expression or pose.
- ABSOLUTELY NO: phone UI, phone screens, app interfaces, on-screen text, momentary UI flashes, screen reflections, or any text/interface elements — even for a single frame. If the character holds a phone, the screen is held facing away from camera or out of frame entirely.
- ABSOLUTELY NO: cinematic lighting, studio lighting, professional photography, professional camera, dramatic angles, slow motion, theatrical pacing.
- ABSOLUTELY NO: airbrushed skin, plastic skin, glossy retouching, perfect symmetric face, doll-like rendering, hyperreal over-saturation.
- The character is a fictional everyday person, NOT based on any real or famous individual. The face, body, voice, and mannerisms must not resemble any celebrity, athlete, musician, politician, influencer, or public personality. Output that resembles a real prominent person is REJECTED by upstream filters.
- No copyrighted character names, no real-world brand spokespeople, no recognizable public figure styling.
- The character speaks DIRECTLY TO CAMERA in natural conversational pace. Full delivery fits in the available duration with no dead air, no long dramatic pauses. Pace matches normal human conversation (~150 words per minute).
- Audio: natural conversational voice, real personality, no robotic monotone, no overly enthusiastic announcer voice, no studio voiceover sound.
- The character in the reference image is THE character. Maintain face, hair, skin tone, outfit, and approximate body shape across the entire video.`;
