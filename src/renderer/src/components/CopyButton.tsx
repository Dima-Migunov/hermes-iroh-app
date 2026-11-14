import { useEffect, useRef, useState } from 'react'

interface CopyButtonProps {
  text: string
  label?: string
  onCopy: (text: string) => Promise<void>
}

export function CopyButton({ text, label = 'Copy', onCopy }: CopyButtonProps) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [])

  const handleClick = async (): Promise<void> => {
    await onCopy(text)
    setCopied(true)
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button type="button" className="copy-button" onClick={() => void handleClick()}>
      {copied ? 'Copied' : label}
    </button>
  )
}
