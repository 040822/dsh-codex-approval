# README 宣传图生成记录

使用内置 image_gen 生成，再根据鲸鱼娘人设参考调整角色。

- 成品：`dsh-codex-approval-banner.png`
- 排版与配色参考：https://github.com/DamonKoy/dsh-web-ui/raw/main/docs/dsh-web-ui-banner.png
- 人设参考：https://github.com/Neko3000/deepseek-whalechan/raw/main/assets/readme/en/character-samples/whalechan-poster-reasoning-conductor.webp

## 初始提示词

```text
Use case: ads-marketing
Asset type: wide GitHub README promotional banner for dsh-codex-approval, approximately 3:1 landscape.
Primary request: an original polished anime whale-girl promotional banner, visually inspired by the reference image seen in conversation: muted misty slate blue, powder blue and periwinkle, soft illustrated background, clean white typography, cute blue-haired whale mascot. Create a fresh composition for an automatic approval plugin for DeepSeek Harness.
Subject: an adorable blue-haired whale-girl mascot on the right, long flowing azure hair, expressive blue eyes, whale-fin hair ornaments and visible whale tail, modest blue-and-white sailor dress, friendly confident smile, holding a small translucent approval card with a simple checkmark. Soft whale silhouettes and a few translucent approval cards integrated subtly into background.
Composition: panoramic banner, left 60 percent clean and low-detail for text, character on right 40 percent, no text-character overlap. Soft dark-blue overlay behind text, refined readable typography, generous margins. Keep main heading on a single line if possible and fully visible.
Text (verbatim): small spaced uppercase eyebrow "DEEPSEEK HARNESS PLUGIN"; large main heading "dsh-codex-approval"; Chinese subtitle "少点审批弹窗，让 Agent 连续工作"; three understated rounded pills "规则优先" "AI 判断" "按需确认".
Style: high-quality 2D anime illustration, crisp graceful linework, soft cel shading, soothing ocean mood, restrained professional open-source project branding; match reference's gentle blue visual family.
Constraints: correct legible text, wholesome mascot, no watermark, no unrelated branding, no claims that all operations are safe or automatically approved.
```

## 人设调整提示词

输入图 1 为初稿横幅，输入图 2 为上述人设参考图。

```text
Use case: identity-preserve
Asset type: GitHub README panoramic banner.
Input image 1 is the banner to edit. Input image 2 is the REQUIRED whalechan character identity reference.
Edit the banner's character to accurately match the second reference: chibi proportions with large round head and small body, deep cobalt-blue hair fading to cyan at the tips, curved single ahoge, big sparkling blue eyes, white frilled maid headband, dark blue whale-fin side ornaments with light undersides and blue bow, navy-and-white modest frilled maid dress with white whale-emblem apron, navy bow with small gold-and-blue jewel, fine gold trim, white stockings, navy shoes, large dark blue whale tail with white underside. Cheerful confident smile. She can hold a translucent approval card with a checkmark. Show the whole cute chibi mascot on the right, not the previous taller pale-haired character. Preserve the banner's panoramic size, ocean-blue palette, subtle ocean background, left-side clean typography and all wording exactly. Keep heading "dsh-codex-approval", eyebrow "DEEPSEEK HARNESS PLUGIN", subtitle "少点审批弹窗，让 Agent 连续工作", pills "规则优先" "AI 判断" "按需确认". Keep text entirely legible. Reference image 2 is for character design only; do not copy its poster text, portrait format, or musical stage. Polished original anime art, friendly blue plugin-family branding.
```
