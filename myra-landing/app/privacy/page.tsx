import { PageHero } from '@/components/page-hero'

export default function PrivacyPage() {
  return (
    <>
      <PageHero
        eyebrow="Legal"
        title="Your data moves with you. Not around you."
        subtitle="Last updated: March 2026"
      />

      <div className="legal-content">
        <p>
          Myra collects only what it needs to match loads, verify carriers, and process payments. We don&apos;t sell data. We don&apos;t broker information. We broker freight.
        </p>

        <h2>Information We Collect</h2>
        <p>
          We collect information you provide directly to us when you create an account, use our services, or communicate with us. This includes:
        </p>
        <ul>
          <li>Name, email address, phone number, and company information</li>
          <li>MC number, DOT number, and insurance details (for carriers)</li>
          <li>Shipping origin, destination, and freight details (for shippers)</li>
          <li>GPS location data when using our driver mobile application</li>
          <li>Documents uploaded to our platform, including BOLs, PODs, and rate confirmations</li>
          <li>Usage data, device information, and log files collected automatically when you access our services</li>
        </ul>

        <h2>How We Use Your Information</h2>
        <p>
          We use the information we collect to provide, maintain, and improve our services. Specifically, we use your information to:
        </p>
        <ul>
          <li>Match carriers with available loads based on equipment, location, and lane preferences</li>
          <li>Provide real-time shipment tracking and estimated delivery times</li>
          <li>Generate rate quotes and market intelligence</li>
          <li>Verify carrier compliance, insurance status, and operating authority</li>
          <li>Process invoices and facilitate payments between parties</li>
          <li>Send service notifications, exception alerts, and operational communications</li>
          <li>Analyze platform usage to improve our algorithms and user experience</li>
        </ul>

        <h2>Information Sharing</h2>
        <p>
          We do not sell your personal information. We share information only in the following circumstances:
        </p>
        <ul>
          <li><strong>Between parties to a shipment:</strong> Shippers, carriers, and brokers involved in the same load may see relevant shipment details, tracking data, and contact information necessary to complete the delivery.</li>
          <li><strong>Service providers:</strong> We work with third-party providers for hosting, analytics, payment processing, and compliance verification. These providers are contractually obligated to protect your data.</li>
          <li><strong>Legal requirements:</strong> We may disclose information when required by law, subpoena, or government regulation, or when we believe disclosure is necessary to protect our rights or the safety of our users.</li>
          <li><strong>Business transfers:</strong> In the event of a merger, acquisition, or sale of assets, your information may be transferred as part of that transaction.</li>
        </ul>

        <h2>Data Security</h2>
        <p>
          We implement industry-standard security measures to protect your information. All data is encrypted in transit using TLS 1.3 and at rest using AES-256 encryption. We maintain SOC 2 Type II compliance and conduct regular security audits. Access to personal data is restricted to authorized personnel on a need-to-know basis.
        </p>
        <p>
          While we take reasonable precautions to protect your data, no method of transmission over the Internet or electronic storage is 100% secure. We cannot guarantee absolute security but are committed to promptly addressing any security incidents.
        </p>

        <h2>Your Rights</h2>
        <p>
          You have the right to access, correct, or delete your personal information at any time. You may also request a copy of the data we hold about you in a portable format. To exercise any of these rights, contact us at the address below.
        </p>
        <p>
          If you are a California resident, you have additional rights under the CCPA, including the right to know what personal information we collect and the right to opt out of the sale of personal information. As noted above, we do not sell personal information.
        </p>

        <h2>Contact Us</h2>
        <p>
          If you have any questions about this Privacy Policy or our data practices, please contact us at:
        </p>
        <p>
          <a href="mailto:privacy@myra-ai.com">privacy@myra-ai.com</a>
        </p>
      </div>
    </>
  )
}
