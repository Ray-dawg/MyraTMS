'use client'

import { useState, useRef } from 'react'
import { Camera, RotateCcw, Upload, Check, Loader2, X, Image as ImageIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { driverFetch } from '@/lib/api'

interface PODCaptureProps {
  loadId: string
  onCaptured: (podUrl: string) => void
  existingPodUrl?: string | null
}

export function PODCapture({ loadId, onCaptured, existingPodUrl }: PODCaptureProps) {
  const [preview, setPreview] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploaded, setUploaded] = useState(!!existingPodUrl)
  const inputRef = useRef<HTMLInputElement>(null)

  function handleCapture(e: React.ChangeEvent<HTMLInputElement>) {
    const selectedFile = e.target.files?.[0]
    if (!selectedFile) return

    setFile(selectedFile)

    // Create preview
    const reader = new FileReader()
    reader.onload = (event) => {
      setPreview(event.target?.result as string)
    }
    reader.readAsDataURL(selectedFile)
  }

  function handleRetake() {
    setPreview(null)
    setFile(null)
    if (inputRef.current) {
      inputRef.current.value = ''
    }
  }

  async function handleUpload() {
    if (!file) return

    setUploading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)

      const res = await driverFetch(`/api/loads/${loadId}/pod`, {
        method: 'POST',
        body: formData,
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Upload failed')
      }

      const data = await res.json()
      setUploaded(true)
      onCaptured(data.podUrl)
      toast.success('POD uploaded successfully')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to upload POD')
    } finally {
      setUploading(false)
    }
  }

  if (uploaded) {
    return (
      <div className="rounded-lg bg-success/10 border border-success/20 p-4 flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-full bg-success/20">
          <Check className="size-5 text-success" />
        </div>
        <div>
          <p className="text-sm font-medium text-success">POD Captured</p>
          <p className="text-xs text-muted-foreground">Proof of delivery has been uploaded</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Hidden file input */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleCapture}
      />

      {preview ? (
        /* Photo preview */
        <div className="relative rounded-lg overflow-hidden border">
          <img
            src={preview}
            alt="POD preview"
            className="w-full max-h-64 object-cover"
          />
          <div className="absolute top-2 right-2 flex gap-2">
            <Button
              variant="secondary"
              size="icon-sm"
              onClick={handleRetake}
              className="bg-background/80 backdrop-blur-sm"
            >
              <RotateCcw className="size-4" />
            </Button>
          </div>
        </div>
      ) : (
        /* Capture button */
        <button
          onClick={() => inputRef.current?.click()}
          className="flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-border p-8 text-muted-foreground hover:border-primary hover:text-primary transition-colors active:bg-primary/5 touch-target"
        >
          <Camera className="size-10" />
          <div className="text-center">
            <p className="text-sm font-medium">Capture Proof of Delivery</p>
            <p className="text-xs">Tap to take a photo or select from gallery</p>
          </div>
        </button>
      )}

      {/* Upload button (shown when photo is taken) */}
      {preview && !uploaded && (
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="flex-1"
            onClick={handleRetake}
            disabled={uploading}
          >
            <RotateCcw className="size-4" />
            Retake
          </Button>
          <Button
            className="flex-1"
            onClick={handleUpload}
            disabled={uploading}
          >
            {uploading ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Uploading...
              </>
            ) : (
              <>
                <Upload className="size-4" />
                Upload POD
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  )
}
