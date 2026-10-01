/** A snippet from search. The server marks found words as «word»; they are shown highlighted. */
export function Highlighted({ text }: { text: string }) {
  // split() with a capture group alternates: plain, match, plain, match, …
  const parts = text.split(/«(.*?)»/)
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? <mark key={i} className="rounded-sm bg-accent-soft px-0.5 text-text">{part}</mark> : part,
      )}
    </>
  )
}
