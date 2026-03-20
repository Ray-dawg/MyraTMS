'use client'

import { useState } from 'react'
import { PageHero } from '@/components/page-hero'

type UserType = 'shipper' | 'carrier' | null

export default function GetStartedPage() {
  const [userType, setUserType] = useState<UserType>(null)
  const [step, setStep] = useState(0)
  const [submitted, setSubmitted] = useState(false)
  const [formData, setFormData] = useState<Record<string, string | boolean>>({})

  const updateField = (field: string, value: string | boolean) => {
    setFormData(prev => ({ ...prev, [field]: value }))
  }

  const totalSteps = userType === 'carrier' ? 5 : 4

  const handleSubmit = () => {
    // In production this would POST to an API endpoint
    // For now, just show success
    setSubmitted(true)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  if (submitted) {
    return (
      <>
        <PageHero
          eyebrow="Application Received"
          title="We got it."
          subtitle={userType === 'carrier'
            ? "Our team will verify your credentials and get back to you within 48 hours."
            : "Our team will review your application and reach out within 24 hours."}
        />
        <div className="onboarding-form-wrap">
          <div className="form-success">
            <div className="form-success-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
            </div>
            <div className="form-success-title">Application Submitted</div>
            <div className="form-success-text">
              {userType === 'carrier'
                ? "Your carrier application has been submitted. Our onboarding team will verify your FMCSA registration, insurance, and safety rating — then reach out to finalize your profile. Verification typically takes 48 hours."
                : "Your shipper application has been submitted. A member of our team will reach out within 24 hours to discuss your freight needs and set up your account. Your first load is on us."}
            </div>
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <PageHero
        eyebrow="Get Started"
        title={userType === null ? "Let\u2019s get you moving." : userType === 'carrier' ? "Join the carrier network." : "Start shipping with Myra."}
        subtitle={userType === null ? "Tell us who you are and we\u2019ll get you set up in minutes." : userType === 'carrier' ? "Complete this application and our team will verify your credentials within 48 hours." : "Tell us about your business and freight needs. First load is on us."}
      />

      <div className="onboarding-form-wrap">
        {/* Progress bar */}
        {userType && (
          <div className="form-progress">
            {Array.from({ length: totalSteps }).map((_, i) => (
              <div
                key={i}
                className={`form-progress-step${i < step ? ' completed' : i === step ? ' current' : ''}`}
              />
            ))}
          </div>
        )}

        {/* Step 0: Choose type */}
        {!userType && (
          <div>
            <div className="form-step-title">I am a...</div>
            <div className="form-step-subtitle">Select your role to see the right application.</div>
            <div className="form-type-selector">
              <div className="form-type-card" onClick={() => { setUserType('shipper'); setStep(0) }}>
                <div className="form-type-card-icon">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#e8601f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect width="20" height="14" x="2" y="5" rx="2" />
                    <path d="M2 10h20" />
                  </svg>
                </div>
                <div className="form-type-card-title">Shipper</div>
                <div className="form-type-card-desc">I need freight moved. I want verified carriers, live tracking, and competitive rates.</div>
              </div>
              <div className="form-type-card" onClick={() => { setUserType('carrier'); setStep(0) }}>
                <div className="form-type-card-icon">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#e8601f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
                    <path d="M15 18h2a1 1 0 0 0 1-1v-3.28a1 1 0 0 0-.684-.948l-1.923-.641a1 1 0 0 1-.684-.949V8a1 1 0 0 0-1-1h-1" />
                    <circle cx="17" cy="18" r="2" /><circle cx="7" cy="18" r="2" />
                  </svg>
                </div>
                <div className="form-type-card-title">Carrier</div>
                <div className="form-type-card-desc">I haul freight. I want loads that fit my lane, fair rates, and fast payment.</div>
              </div>
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════
            SHIPPER FORM
        ═══════════════════════════════════════ */}
        {userType === 'shipper' && (
          <>
            {/* Step 0: Company Info */}
            <div className={`form-step${step === 0 ? ' active' : ''}`}>
              <div className="form-step-title">Company Information</div>
              <div className="form-step-subtitle">Basic details about your business.</div>

              <div className="form-group">
                <label className="form-label">Business Name</label>
                <input className="form-input" placeholder="e.g. Acme Distribution LLC" value={formData.businessName as string || ''} onChange={e => updateField('businessName', e.target.value)} />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Business Registration #</label>
                  <input className="form-input" placeholder="Corporation / LLC number" value={formData.businessRegNumber as string || ''} onChange={e => updateField('businessRegNumber', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Tax ID / EIN</label>
                  <input className="form-input" placeholder="XX-XXXXXXX" value={formData.taxId as string || ''} onChange={e => updateField('taxId', e.target.value)} />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Business Address</label>
                <input className="form-input" placeholder="Street, City, State, ZIP" value={formData.businessAddress as string || ''} onChange={e => updateField('businessAddress', e.target.value)} />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Phone Number</label>
                  <input className="form-input" type="tel" placeholder="(555) 555-5555" value={formData.phone as string || ''} onChange={e => updateField('phone', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Company Website</label>
                  <input className="form-input" placeholder="https://" value={formData.website as string || ''} onChange={e => updateField('website', e.target.value)} />
                </div>
              </div>

              <div className="form-nav">
                <button className="form-btn-back" onClick={() => { setUserType(null); setStep(0) }}>← Back</button>
                <button className="btn-primary-lg" onClick={() => { setStep(1); window.scrollTo({ top: 0, behavior: 'smooth' }) }}>Continue</button>
              </div>
            </div>

            {/* Step 1: Contact Person */}
            <div className={`form-step${step === 1 ? ' active' : ''}`}>
              <div className="form-step-title">Primary Contact</div>
              <div className="form-step-subtitle">Who should we reach out to?</div>

              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">First Name</label>
                  <input className="form-input" placeholder="First name" value={formData.contactFirstName as string || ''} onChange={e => updateField('contactFirstName', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Last Name</label>
                  <input className="form-input" placeholder="Last name" value={formData.contactLastName as string || ''} onChange={e => updateField('contactLastName', e.target.value)} />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Email Address</label>
                <input className="form-input" type="email" placeholder="you@company.com" value={formData.contactEmail as string || ''} onChange={e => updateField('contactEmail', e.target.value)} />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Job Title</label>
                  <input className="form-input" placeholder="e.g. Logistics Manager" value={formData.contactTitle as string || ''} onChange={e => updateField('contactTitle', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Direct Phone</label>
                  <input className="form-input" type="tel" placeholder="(555) 555-5555" value={formData.contactPhone as string || ''} onChange={e => updateField('contactPhone', e.target.value)} />
                </div>
              </div>

              <div className="form-nav">
                <button className="form-btn-back" onClick={() => setStep(0)}>← Back</button>
                <button className="btn-primary-lg" onClick={() => { setStep(2); window.scrollTo({ top: 0, behavior: 'smooth' }) }}>Continue</button>
              </div>
            </div>

            {/* Step 2: Freight Needs */}
            <div className={`form-step${step === 2 ? ' active' : ''}`}>
              <div className="form-step-title">Freight Profile</div>
              <div className="form-step-subtitle">Help us understand your shipping needs so we can match you with the right carriers.</div>

              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Avg Loads Per Month</label>
                  <select className="form-select" value={formData.loadsPerMonth as string || ''} onChange={e => updateField('loadsPerMonth', e.target.value)}>
                    <option value="">Select...</option>
                    <option value="1-5">1–5 loads</option>
                    <option value="6-20">6–20 loads</option>
                    <option value="21-50">21–50 loads</option>
                    <option value="51-100">51–100 loads</option>
                    <option value="100+">100+ loads</option>
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Equipment Type Needed</label>
                  <select className="form-select" value={formData.equipmentType as string || ''} onChange={e => updateField('equipmentType', e.target.value)}>
                    <option value="">Select...</option>
                    <option value="dry-van">Dry Van</option>
                    <option value="reefer">Reefer</option>
                    <option value="flatbed">Flatbed</option>
                    <option value="step-deck">Step Deck</option>
                    <option value="multiple">Multiple Types</option>
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Primary Shipping Lanes</label>
                <input className="form-input" placeholder="e.g. Chicago → Atlanta, Dallas → Houston" value={formData.primaryLanes as string || ''} onChange={e => updateField('primaryLanes', e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Typical Commodity</label>
                <input className="form-input" placeholder="e.g. Consumer electronics, dry goods, produce" value={formData.commodity as string || ''} onChange={e => updateField('commodity', e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">How Are You Currently Booking Freight?</label>
                <select className="form-select" value={formData.currentBooking as string || ''} onChange={e => updateField('currentBooking', e.target.value)}>
                  <option value="">Select...</option>
                  <option value="broker">Traditional broker</option>
                  <option value="load-board">Load boards (DAT, Truckstop)</option>
                  <option value="direct">Direct carrier relationships</option>
                  <option value="tms">TMS platform</option>
                  <option value="mix">Mix of the above</option>
                </select>
              </div>

              <div className="form-nav">
                <button className="form-btn-back" onClick={() => setStep(1)}>← Back</button>
                <button className="btn-primary-lg" onClick={() => { setStep(3); window.scrollTo({ top: 0, behavior: 'smooth' }) }}>Continue</button>
              </div>
            </div>

            {/* Step 3: Authorization & Submit */}
            <div className={`form-step${step === 3 ? ' active' : ''}`}>
              <div className="form-step-title">Authorization</div>
              <div className="form-step-subtitle">A few final items so our team can get started on your account.</div>

              <div className="form-group">
                <label className="form-label">Additional Notes</label>
                <textarea className="form-textarea" placeholder="Anything else we should know? Special requirements, urgent timelines, etc." value={formData.notes as string || ''} onChange={e => updateField('notes', e.target.value)} />
              </div>

              <div className="form-checkbox-group" onClick={() => updateField('creditCheckAuth', !formData.creditCheckAuth)}>
                <input type="checkbox" className="form-checkbox" checked={!!formData.creditCheckAuth} readOnly />
                <label className="form-checkbox-label">
                  I authorize Myra AI to perform a standard business credit check.
                  <span>Required for setting up payment terms. This is a soft inquiry and will not affect your credit score.</span>
                </label>
              </div>

              <div className="form-checkbox-group" onClick={() => updateField('termsAccepted', !formData.termsAccepted)}>
                <input type="checkbox" className="form-checkbox" checked={!!formData.termsAccepted} readOnly />
                <label className="form-checkbox-label">
                  I agree to Myra&apos;s Terms of Service and Privacy Policy.
                  <span>You can review our terms at /terms and privacy policy at /privacy.</span>
                </label>
              </div>

              <div className="form-nav">
                <button className="form-btn-back" onClick={() => setStep(2)}>← Back</button>
                <button className="btn-primary-lg" onClick={handleSubmit}>Submit Application</button>
              </div>
            </div>
          </>
        )}

        {/* ═══════════════════════════════════════
            CARRIER FORM
        ═══════════════════════════════════════ */}
        {userType === 'carrier' && (
          <>
            {/* Step 0: Company Info */}
            <div className={`form-step${step === 0 ? ' active' : ''}`}>
              <div className="form-step-title">Carrier Information</div>
              <div className="form-step-subtitle">Tell us about your operation.</div>

              <div className="form-group">
                <label className="form-label">Legal Business Name</label>
                <input className="form-input" placeholder="As registered with FMCSA" value={formData.businessName as string || ''} onChange={e => updateField('businessName', e.target.value)} />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">MC Number</label>
                  <input className="form-input" placeholder="MC-XXXXXX" value={formData.mcNumber as string || ''} onChange={e => updateField('mcNumber', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">DOT Number</label>
                  <input className="form-input" placeholder="XXXXXXX" value={formData.dotNumber as string || ''} onChange={e => updateField('dotNumber', e.target.value)} />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Tax ID / EIN</label>
                  <input className="form-input" placeholder="XX-XXXXXXX" value={formData.taxId as string || ''} onChange={e => updateField('taxId', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Business Registration #</label>
                  <input className="form-input" placeholder="State registration number" value={formData.businessRegNumber as string || ''} onChange={e => updateField('businessRegNumber', e.target.value)} />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Business Address</label>
                <input className="form-input" placeholder="Street, City, State, ZIP" value={formData.businessAddress as string || ''} onChange={e => updateField('businessAddress', e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Phone Number</label>
                <input className="form-input" type="tel" placeholder="(555) 555-5555" value={formData.phone as string || ''} onChange={e => updateField('phone', e.target.value)} />
              </div>

              <div className="form-nav">
                <button className="form-btn-back" onClick={() => { setUserType(null); setStep(0) }}>← Back</button>
                <button className="btn-primary-lg" onClick={() => { setStep(1); window.scrollTo({ top: 0, behavior: 'smooth' }) }}>Continue</button>
              </div>
            </div>

            {/* Step 1: Contact Person */}
            <div className={`form-step${step === 1 ? ' active' : ''}`}>
              <div className="form-step-title">Primary Contact</div>
              <div className="form-step-subtitle">Who should our dispatch team contact?</div>

              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">First Name</label>
                  <input className="form-input" placeholder="First name" value={formData.contactFirstName as string || ''} onChange={e => updateField('contactFirstName', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Last Name</label>
                  <input className="form-input" placeholder="Last name" value={formData.contactLastName as string || ''} onChange={e => updateField('contactLastName', e.target.value)} />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Email Address</label>
                <input className="form-input" type="email" placeholder="you@company.com" value={formData.contactEmail as string || ''} onChange={e => updateField('contactEmail', e.target.value)} />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Role</label>
                  <select className="form-select" value={formData.contactRole as string || ''} onChange={e => updateField('contactRole', e.target.value)}>
                    <option value="">Select...</option>
                    <option value="owner-operator">Owner-Operator</option>
                    <option value="fleet-owner">Fleet Owner</option>
                    <option value="dispatcher">Dispatcher</option>
                    <option value="operations-manager">Operations Manager</option>
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Direct Phone</label>
                  <input className="form-input" type="tel" placeholder="(555) 555-5555" value={formData.contactPhone as string || ''} onChange={e => updateField('contactPhone', e.target.value)} />
                </div>
              </div>

              <div className="form-nav">
                <button className="form-btn-back" onClick={() => setStep(0)}>← Back</button>
                <button className="btn-primary-lg" onClick={() => { setStep(2); window.scrollTo({ top: 0, behavior: 'smooth' }) }}>Continue</button>
              </div>
            </div>

            {/* Step 2: Fleet & Equipment */}
            <div className={`form-step${step === 2 ? ' active' : ''}`}>
              <div className="form-step-title">Fleet & Equipment</div>
              <div className="form-step-subtitle">Tell us what you run so we can match you to the right loads.</div>

              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Fleet Size</label>
                  <select className="form-select" value={formData.fleetSize as string || ''} onChange={e => updateField('fleetSize', e.target.value)}>
                    <option value="">Select...</option>
                    <option value="1">1 truck (owner-operator)</option>
                    <option value="2-5">2–5 trucks</option>
                    <option value="6-20">6–20 trucks</option>
                    <option value="21-50">21–50 trucks</option>
                    <option value="50+">50+ trucks</option>
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Equipment Type</label>
                  <select className="form-select" value={formData.equipmentType as string || ''} onChange={e => updateField('equipmentType', e.target.value)}>
                    <option value="">Select...</option>
                    <option value="dry-van">Dry Van</option>
                    <option value="reefer">Reefer</option>
                    <option value="flatbed">Flatbed</option>
                    <option value="step-deck">Step Deck</option>
                    <option value="multiple">Multiple Types</option>
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Preferred Lanes</label>
                <input className="form-input" placeholder="e.g. Ontario → Michigan, I-75 corridor, Southeast regional" value={formData.preferredLanes as string || ''} onChange={e => updateField('preferredLanes', e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Home Base / Terminal Location</label>
                <input className="form-input" placeholder="City, State/Province" value={formData.homeBase as string || ''} onChange={e => updateField('homeBase', e.target.value)} />
              </div>

              <div className="form-nav">
                <button className="form-btn-back" onClick={() => setStep(1)}>← Back</button>
                <button className="btn-primary-lg" onClick={() => { setStep(3); window.scrollTo({ top: 0, behavior: 'smooth' }) }}>Continue</button>
              </div>
            </div>

            {/* Step 3: Insurance & Compliance */}
            <div className={`form-step${step === 3 ? ' active' : ''}`}>
              <div className="form-step-title">Insurance & Compliance</div>
              <div className="form-step-subtitle">We verify all carriers before their first load. This information helps us fast-track your application.</div>

              <div className="form-group">
                <label className="form-label">Cargo Insurance Provider</label>
                <input className="form-input" placeholder="Insurance company name" value={formData.insuranceProvider as string || ''} onChange={e => updateField('insuranceProvider', e.target.value)} />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Cargo Coverage Amount</label>
                  <select className="form-select" value={formData.cargoCoverage as string || ''} onChange={e => updateField('cargoCoverage', e.target.value)}>
                    <option value="">Select...</option>
                    <option value="under-1m">Under $1M</option>
                    <option value="1m-2m">$1M – $2M</option>
                    <option value="2m+">$2M+ (meets Myra standard)</option>
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Policy Expiration Date</label>
                  <input className="form-input" type="date" value={formData.policyExpiry as string || ''} onChange={e => updateField('policyExpiry', e.target.value)} />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">FMCSA Safety Rating</label>
                <select className="form-select" value={formData.safetyRating as string || ''} onChange={e => updateField('safetyRating', e.target.value)}>
                  <option value="">Select...</option>
                  <option value="satisfactory">Satisfactory</option>
                  <option value="conditional">Conditional</option>
                  <option value="not-rated">Not Yet Rated</option>
                </select>
              </div>

              <div className="form-nav">
                <button className="form-btn-back" onClick={() => setStep(2)}>← Back</button>
                <button className="btn-primary-lg" onClick={() => { setStep(4); window.scrollTo({ top: 0, behavior: 'smooth' }) }}>Continue</button>
              </div>
            </div>

            {/* Step 4: Authorization & Submit */}
            <div className={`form-step${step === 4 ? ' active' : ''}`}>
              <div className="form-step-title">Authorization</div>
              <div className="form-step-subtitle">Final step. Authorize verification and submit your application.</div>

              <div className="form-group">
                <label className="form-label">Additional Notes</label>
                <textarea className="form-textarea" placeholder="Anything else? Special equipment, certifications (HAZMAT, TWIC), etc." value={formData.notes as string || ''} onChange={e => updateField('notes', e.target.value)} />
              </div>

              <div className="form-checkbox-group" onClick={() => updateField('fmcsaAuth', !formData.fmcsaAuth)}>
                <input type="checkbox" className="form-checkbox" checked={!!formData.fmcsaAuth} readOnly />
                <label className="form-checkbox-label">
                  I authorize Myra AI to verify my FMCSA registration, safety rating, and insurance status.
                  <span>We pull this information directly from FMCSA and your insurance provider on file.</span>
                </label>
              </div>

              <div className="form-checkbox-group" onClick={() => updateField('creditCheckAuth', !formData.creditCheckAuth)}>
                <input type="checkbox" className="form-checkbox" checked={!!formData.creditCheckAuth} readOnly />
                <label className="form-checkbox-label">
                  I authorize a standard business credit check.
                  <span>Soft inquiry only. Will not affect your credit score.</span>
                </label>
              </div>

              <div className="form-checkbox-group" onClick={() => updateField('termsAccepted', !formData.termsAccepted)}>
                <input type="checkbox" className="form-checkbox" checked={!!formData.termsAccepted} readOnly />
                <label className="form-checkbox-label">
                  I agree to Myra&apos;s Terms of Service and Privacy Policy.
                  <span>Review at /terms and /privacy.</span>
                </label>
              </div>

              <div className="form-nav">
                <button className="form-btn-back" onClick={() => setStep(3)}>← Back</button>
                <button className="btn-primary-lg" onClick={handleSubmit}>Submit Application</button>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  )
}
