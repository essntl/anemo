# Word count

A panel on every document (in the document's side panel) that shows:

- **Words** and **paragraphs**
- **Characters**, with and without spaces
- **Reading time** (at about 230 words a minute) and **speaking time** (at about 140 words a
  minute, for a talk or a recording)
- The **longest paragraph**: its first words and how many words it has, so you can see
  where a text could be split

The numbers are for the text someone actually reads. Before counting, the panel leaves out
the document's properties (the front matter at the top), code blocks, HTML tags and the
Markdown marks around the text (`#`, `**`, list bullets, link addresses). Headings count as
words but not as paragraphs.

The panel counts again as soon as the document is saved, and grows or shrinks to fit its
numbers.

## Permissions

Only **`documents:read`**: to read the text of the document the panel is shown next to.
The panel never changes a document, never sends anything anywhere (plugin frames have no
network access) and keeps nothing.

## How it is built

This plugin is also an example of a plugin's UI. It is three small files and no
libraries:

- `ui/panel.html`: the markup (six tiles and the longest paragraph)
- `ui/panel.css`: the layout, using only Anemo's theme variables (`--surface-2`, `--muted`…),
  so it looks right in light and dark mode
- `ui/panel.js`: reads the document with `anemo.call('documents.get', {id})`, counts, and
  listens for `object.changed` and `context.changed`; `anemo.ui.resize` keeps the panel as
  tall as its content
