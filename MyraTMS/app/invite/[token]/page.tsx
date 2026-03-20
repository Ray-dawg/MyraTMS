"use client"

import { useState, useEffect, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import Image from "next/image"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Loader2, AlertCircle, CheckCircle2 } from "lucide-react"

interface InviteInfo {
  email: string
  role: string
  firstName: string | null
  lastName: string | null
}

export default function AcceptInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const router = useRouter()
  const [token, setToken] = useState("")
  const [invite, setInvite] = useState<InviteInfo | null>(null)
  const [status, setStatus] = useState<"loading" | "valid" | "invalid" | "expired" | "used">("loading")
  const [errorMsg, setErrorMsg] = useState("")

  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState("")
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    params.then(({ token: t }) => {
      setToken(t)
      fetch(`/api/auth/accept-invite?token=${t}`)
        .then(async (res) => {
          if (res.ok) {
            const data = await res.json()
            setInvite(data.invite)
            setFirstName(data.invite.firstName || "")
            setLastName(data.invite.lastName || "")
            setStatus("valid")
          } else if (res.status === 410) {
            const data = await res.json()
            if (data.error?.includes("already been used")) {
              setStatus("used")
            } else {
              setStatus("expired")
            }
          } else {
            setStatus("invalid")
            const data = await res.json()
            setErrorMsg(data.error || "Invalid invitation")
          }
        })
        .catch(() => {
          setStatus("invalid")
          setErrorMsg("Failed to validate invitation")
        })
    })
  }, [params])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitError("")

    if (password.length < 6) {
      setSubmitError("Password must be at least 6 characters")
      return
    }
    if (password !== confirmPassword) {
      setSubmitError("Passwords do not match")
      return
    }

    setSubmitting(true)

    try {
      const res = await fetch("/api/auth/accept-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, firstName, lastName, password }),
      })

      if (res.ok) {
        setSuccess(true)
        setTimeout(() => router.push("/"), 2000)
      } else {
        const data = await res.json()
        setSubmitError(data.error || "Failed to create account")
      }
    } catch {
      setSubmitError("Network error. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (status === "invalid" || status === "expired" || status === "used") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-sm text-center">
          <div className="mb-6 flex flex-col items-center gap-3">
            <Image src="/logo.png" alt="Myra" width={64} height={64} className="rounded-xl" />
            <h1 className="text-2xl font-bold tracking-tight">Myra Logistics</h1>
          </div>
          <Card>
            <CardContent className="pt-6">
              <div className="flex flex-col items-center gap-3">
                <AlertCircle className="h-10 w-10 text-destructive" />
                <p className="font-semibold text-lg">
                  {status === "expired" ? "Invitation Expired" :
                   status === "used" ? "Invitation Already Used" :
                   "Invalid Invitation"}
                </p>
                <p className="text-sm text-muted-foreground">
                  {status === "expired"
                    ? "This invitation has expired. Please ask your admin to send a new one."
                    : status === "used"
                    ? "This invitation has already been accepted. Try logging in instead."
                    : errorMsg || "This invitation link is not valid."}
                </p>
                <Button variant="outline" className="mt-2" onClick={() => router.push("/login")}>
                  Go to Login
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  if (success) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-sm text-center">
          <Card>
            <CardContent className="pt-6">
              <div className="flex flex-col items-center gap-3">
                <CheckCircle2 className="h-10 w-10 text-green-500" />
                <p className="font-semibold text-lg">Account Created!</p>
                <p className="text-sm text-muted-foreground">
                  Welcome to Myra Logistics. Redirecting to the dashboard...
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-2">
          <Image src="/logo.png" alt="Myra" width={64} height={64} className="rounded-xl" />
          <h1 className="text-2xl font-bold tracking-tight">Myra Logistics</h1>
          <p className="text-sm text-muted-foreground">Create your account</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Accept Invitation</CardTitle>
            <CardDescription>
              You&apos;ve been invited as a <span className="font-medium capitalize">{invite?.role}</span> for{" "}
              <span className="font-medium">{invite?.email}</span>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="firstName">First Name</Label>
                  <Input
                    id="firstName"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    required
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="lastName">Last Name</Label>
                  <Input
                    id="lastName"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    required
                  />
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" value={invite?.email || ""} disabled className="bg-muted" />
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 6 characters"
                  required
                  minLength={6}
                />
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="confirmPassword">Confirm Password</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={6}
                />
              </div>

              {submitError && (
                <p className="text-sm text-destructive">{submitError}</p>
              )}

              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create Account
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
