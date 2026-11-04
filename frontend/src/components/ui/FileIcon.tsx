import { File, FileArchive, FileCode, FileImage, FileSpreadsheet, FileText, Presentation } from 'lucide-react'

const CODE = /\.(py|js|mjs|cjs|ts|tsx|jsx|sh|bash|ps1|bat|go|rs|java|kt|c|h|cpp|hpp|cs|rb|php|swift|lua|r|sql|html|css|json|ya?ml|toml|xml|ipynb)$/i
const SHEET = /\.(xlsx|xlsm|xls|ods|csv|tsv)$/i
const SLIDES = /\.(pptx?|odp|key)$/i
const ARCHIVE = /\.(zip|tar|gz|tgz|7z|rar)$/i

interface FileIconProps {
  name: string
  /** As the server classified the file: image | pdf | document | spreadsheet | presentation | archive | text | file */
  kind?: string | null
  className?: string
}

/** An icon for a file, from its kind or, failing that, its name. */
export function FileIcon({ name, kind, className }: FileIconProps) {
  if (kind === 'image') return <FileImage className={className} />
  if (kind === 'spreadsheet' || SHEET.test(name)) return <FileSpreadsheet className={className} />
  if (kind === 'presentation' || SLIDES.test(name)) return <Presentation className={className} />
  if (kind === 'archive' || ARCHIVE.test(name)) return <FileArchive className={className} />
  if (CODE.test(name)) return <FileCode className={className} />
  if (kind === 'file') return <File className={className} />
  return <FileText className={className} />
}
