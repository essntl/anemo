// Runs inside the page. Describes what is on it for the agent: the visible text,
// and the things one can click or type into, each with a number ("ref") that the
// agent uses to say which one it means. The number is stored on the element as
// data-anemo-ref so the next action can find it again.
(limits) => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

  const visible = (el) => {
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false
    const box = el.getBoundingClientRect()
    return box.width > 1 && box.height > 1
  }

  document.querySelectorAll('[data-anemo-ref]').forEach((el) => el.removeAttribute('data-anemo-ref'))
  const candidates = document.querySelectorAll(
    'a[href], button, input, select, textarea, summary, [role=button], [role=link], [role=tab], ' +
      '[role=menuitem], [role=checkbox], [role=radio], [role=switch], [role=combobox], [contenteditable=true], [onclick]',
  )

  // The text of a <label> around a field, without the field's own text (a
  // dropdown's options would otherwise end up in its label).
  const wrappingLabel = (el) => {
    const label = el.closest('label')
    if (!label) return ''
    const copy = label.cloneNode(true)
    copy.querySelectorAll('select, input, textarea').forEach((field) => field.remove())
    return copy.textContent
  }

  const labelOf = (el) => {
    const byId = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
    return clean(
      el.getAttribute('aria-label') ||
        (byId && byId.innerText) ||
        wrappingLabel(el) ||
        el.getAttribute('placeholder') ||
        el.getAttribute('title') ||
        el.getAttribute('name') ||
        '',
    )
  }

  const elements = []
  let total = 0
  for (const el of candidates) {
    if (el.disabled || el.getAttribute('aria-hidden') === 'true' || !visible(el)) continue
    if (el.tagName === 'INPUT' && el.type === 'hidden') continue
    total += 1
    if (elements.length >= limits.maxElements) continue
    const ref = elements.length + 1
    el.setAttribute('data-anemo-ref', String(ref))
    const tag = el.tagName.toLowerCase()
    let line
    if (tag === 'a') {
      line = `link "${cut(clean(el.innerText) || labelOf(el), 80)}"`
    } else if (tag === 'input' || tag === 'textarea') {
      const type = tag === 'textarea' ? 'textarea' : el.type || 'text'
      if (type === 'checkbox' || type === 'radio') {
        line = `${type} "${cut(labelOf(el), 80)}"${el.checked ? ' (checked)' : ''}`
      } else if (type === 'submit' || type === 'button' || type === 'reset') {
        line = `button "${cut(clean(el.value) || labelOf(el), 80)}"`
      } else {
        // Never echo what was typed into a password field.
        const value = type === 'password' ? (el.value ? '••••' : '') : cut(clean(el.value), 60)
        line = `${type} field "${cut(labelOf(el), 80)}"${value ? ` value "${value}"` : ''}`
      }
    } else if (tag === 'select') {
      const chosen = el.selectedOptions[0] ? clean(el.selectedOptions[0].innerText) : ''
      const options = Array.from(el.options).slice(0, 12).map((o) => clean(o.innerText))
      line = `dropdown "${cut(labelOf(el), 60)}" value "${cut(chosen, 40)}" options: ${cut(options.join(' | '), 200)}`
    } else {
      const role = el.getAttribute('role') || (tag === 'summary' ? 'toggle' : 'button')
      line = `${role} "${cut(clean(el.innerText) || labelOf(el), 80)}"`
    }
    elements.push(`[${ref}] ${line}`)
  }

  const text = clean(document.body ? document.body.innerText : '')

  // A page that only checks whether the visitor is a person (Cloudflare, CAPTCHAs).
  // Such a page is short and is either worded like a check or built around one.
  const checkWords = /verify(ing)? (that )?you are (a )?human|security verification|checking your browser|are you a robot|unusual traffic|complete the captcha/i
  const checkWidget = document.querySelector(
    'iframe[src*="challenges.cloudflare.com"], iframe[src*="/recaptcha/"], iframe[src*="hcaptcha.com"], ' +
      '.cf-turnstile, #challenge-form, #challenge-stage, .g-recaptcha, .h-captcha',
  )
  const botCheck = text.length < 800 && (checkWords.test(text) || checkWords.test(document.title) || Boolean(checkWidget))

  return {
    botCheck,
    url: location.href,
    title: document.title,
    text: cut(text, limits.maxText),
    textCut: text.length > limits.maxText,
    elements,
    moreElements: total - elements.length,
    scroll: {
      y: Math.round(window.scrollY),
      height: Math.round(document.documentElement.scrollHeight),
      viewport: window.innerHeight,
    },
  }
}
