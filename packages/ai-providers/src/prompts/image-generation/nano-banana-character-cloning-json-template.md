Here's how to clone images with nano banana using gemini:

1. Upload the image you want to clone
   I wanted to clone this one for example:

2. Use this prompt:
   Use this template to analyze the image and generate a json prompt. Follow the structure of the template exactly. Do not change the format, do not remove or add sections, and keep all keys identical to the template. The output must be a single json block strictly matching the template while accurately describing the uploaded image: {
   "subject": {
   "description": "Dr. Barbara O'Neill talking directly to the camera in a podcast setting",
   "mirror_rules": "standard view, no text inversion required, clean frame",
   "age": "mature adult",
   "expression": "engaging, speaking with a warm and friendly demeanor, natural smile lines",
   "hair": {
   "color": "light brown/auburn with natural grey strands",
   "style": "long wavy hair, pulled back from the forehead (half-up style) and falling down over the shoulders"
   },
   "clothing": {
   "top": {
   "type": "casual long-sleeve top",
   "color": "random soft color (e.g., beige, navy, or sage green)",
   "details": "modest neckline, comfortable fit, unbranded"
   },
   "bottom": {
   "type": "not visible",
   "color": "n/a",
   "details": "n/a"
   }
   },
   "face": {
   "preserve_original": true,
   "makeup": "minimal, natural mature skin texture, no heavy makeup"
   }
   },
   "accessories": {
   "headwear": {
   "type": "none",
   "details": "none"
   },
   "jewelry": {
   "earrings": "small simple studs (optional)",
   "necklace": "none",
   "wrist": "not visible",
   "rings": "not visible"
   },
   "device": {
   "type": "professional microphone",
   "details": "large broadcast microphone on a boom arm visible in frame near face"
   },
   "prop": {
   "type": "none",
   "details": "none"
   }
   },
   "photography": {
   "camera_style": "iPhone photography, UGC aesthetic",
   "angle": "eye-level, direct address",
   "shot_type": "medium close-up, chest up",
   "aspect_ratio": "9:16 vertical",
   "texture": "authentic, sharp focus, slight digital noise characteristic of phone cameras, no filters"
   },
   "background": {
   "setting": "home studio or podcast room",
   "wall_color": "neutral tones",
   "elements": [
   "blurred bookshelf or acoustic foam panels",
   "soft depth of field",
   "clean background without clutter"
   ],
   "atmosphere": "informative, intimate, conversational",
   "lighting": "soft ring light or natural window light illuminating face"
   }
   }
   —--------------

That's it, this is how it looks like:
Kling o3 GEM
Use this prompt below to create a gem like we used to do in this course, for kling o3. This is mostly about kling o3. Make sure to upload elements as references. Will be expanded shortly on how to use it.
Use the material as knowledge and upload to the gem:
[material](https://drive.google.com/drive/folders/1y9ArbIVwyg-jG7ce0IaMRODOXNNxNhB_?usp=sharing)
Steps to use it:

- Upload video to analyze
- Gemini will give you prompts for kling
- Replace the @ with the correct element tags from the kling app
  PROMPT FOR THE GEM:
  [gem prompt](https://docs.google.com/document/d/1sEHgVjFLl4yOsCRS-HtIgSA8WJZWzXNQxO7FldcZuus/edit?usp=sharing)
