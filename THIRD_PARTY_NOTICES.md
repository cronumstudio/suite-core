# Third-party notices

suite-core is Copyright (C) 2026 Martin Andersen (Cronum Studio) and is licensed under the GNU Affero General Public
License v3.0 only (see [LICENSE](LICENSE)). It has no npm dependencies. The material below comes
from other projects, is included in this repository, and stays under its own licence.

| Material | Where | Version | Licence |
| --- | --- | --- | --- |
| [Geist](https://github.com/vercel/geist-font) and Geist Mono (fonts) | `web/fonts/geist-*.woff2` | Geist 1.800, Geist Mono 1.701 | SIL Open Font License 1.1 |
| [Inter](https://github.com/rsms/inter) (font) | `web/fonts/inter-*.woff2` | 4.001 | SIL Open Font License 1.1 |
| [Space Grotesk](https://github.com/floriankarsten/space-grotesk) (font) | `web/fonts/space-grotesk-*.woff2` | 2.000 | SIL Open Font License 1.1 |
| [Lucide](https://lucide.dev) (icons) | `web/icons.js` | 1.53.0 | ISC; some of the icons derive from Feather (MIT) |
| [LobeHub Icons](https://github.com/lobehub/lobe-icons), `@lobehub/icons-static-svg` | `web/agents.js` | 1.98.0 | MIT |
| [Codicons](https://github.com/microsoft/vscode-codicons), `@vscode/codicons` | `web/agents.js` | 0.0.36 | CC BY 4.0 |

QR codes, zip archives, Markdown, Web Push and the other formats and protocols are written here
from their specifications, not taken from other projects.

## Fonts

The fonts are subsets (Latin and Latin Extended) in WOFF2, served from `/suite/fonts/`. Each one's
licence is next to it, in full:

- **Geist and Geist Mono**: Copyright 2024 The Geist Project Authors
  (https://github.com/vercel/geist-font). SIL Open Font License, Version 1.1:
  [web/fonts/OFL-Geist.txt](web/fonts/OFL-Geist.txt).
- **Inter**: Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter). SIL Open
  Font License, Version 1.1: [web/fonts/OFL-Inter.txt](web/fonts/OFL-Inter.txt).
- **Space Grotesk**: Copyright 2020 The Space Grotesk Project Authors
  (https://github.com/floriankarsten/space-grotesk). SIL Open Font License, Version 1.1:
  [web/fonts/OFL-SpaceGrotesk.txt](web/fonts/OFL-SpaceGrotesk.txt).

## Lucide

These icons of `web/icons.js` are Lucide's, each drawn as one path on the kit's grid: `bold`,
`camera`, `code-xml`, `eraser`, `heading`, `heading-1`, `heading-2`, `heading-3`, `highlighter`,
`image`, `italic`, `link`, `list`, `list-indent-decrease`, `list-indent-increase`, `list-ordered`,
`list-todo`, `marker` (Lucide's `brush`), `pen`, `redo-2`, `strikethrough`, `table` and `undo-2`.

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

Of the icons above, `italic` and `link` are among those Lucide's licence lists as derived from the
Feather project, under this licence:

```
The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Some of the kit's other icons are drawn close to Lucide's or Feather's: `book`, `clip`, `copy`,
`eye`, `filter`, `flag`, `fork`, `globe`, `history`, `logout`, `star`, `sun`, `users`, `zoom-in`
and `zoom-out`. The two licences above cover them too.

## LobeHub Icons

The marks of Claude, ChatGPT, Grok, Perplexity, Claude Code, Codex, Gemini CLI and Cursor in
`web/agents.js` are drawn from `@lobehub/icons-static-svg` 1.98.0, in one colour (the text's).

```
MIT License

Copyright (c) 2023 LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Codicons

The VS Code mark in `web/agents.js` is the `vscode` icon of
[Codicons](https://github.com/microsoft/vscode-codicons) (`@vscode/codicons` 0.0.36), Copyright (c)
Microsoft Corporation, licensed under the Creative Commons Attribution 4.0 International licence
(CC BY 4.0, https://creativecommons.org/licenses/by/4.0/). It is used as one path, filled with the
text's colour. The material is offered as-is, without warranties of any kind, as Section 5 of that
licence says.

## Trademarks

The names and marks of other products shown here belong to their owners: Claude and Claude Code
(Anthropic), ChatGPT and Codex (OpenAI), Grok (xAI), Perplexity (Perplexity AI), Gemini (Google),
Cursor (Anysphere), VS Code (Microsoft), and any other product named in this repository. They are
used only to name those products where suite-core says how to connect them, and their use does not
mean that their owners endorse suite-core or Cronum Studio. The licences above cover the drawings,
not the marks.
