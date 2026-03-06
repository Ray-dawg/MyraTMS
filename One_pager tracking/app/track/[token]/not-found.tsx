import Image from "next/image"
import Link from "next/link"

export default function TrackingNotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 font-sans">
      <div className="mx-auto max-w-md text-center">
        <div className="mb-6 flex items-center justify-center gap-2">
          <Image
            src="/myra-logo.png"
            alt="Myra AI"
            width={32}
            height={32}
            className="rounded-lg"
          />
          <span className="text-lg font-semibold text-foreground">Myra</span>
          <span className="text-lg font-semibold text-primary">AI</span>
        </div>

        <div className="rounded-xl border border-border bg-card p-8">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10 mx-auto">
            <svg
              className="h-7 w-7 text-destructive"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
              />
            </svg>
          </div>

          <h1 className="mb-2 text-xl font-semibold text-foreground">
            Tracking Link Not Found
          </h1>
          <p className="mb-6 text-sm text-muted-foreground leading-relaxed">
            This tracking link is invalid or has expired. If you received this
            link from your broker, please contact them for an updated tracking
            URL.
          </p>

          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go to Demo
          </Link>
        </div>

        <p className="mt-6 text-[10px] text-muted-foreground/50">
          &copy; {new Date().getFullYear()} Myra AI, Inc.
        </p>
      </div>
    </div>
  )
}
