import { PageHero } from '@/components/page-hero'

export default function TermsPage() {
  return (
    <>
      <PageHero
        eyebrow="Legal"
        title="Straightforward terms for a straightforward service."
        subtitle="Last updated: March 2026"
      />

      <div className="legal-content">
        <p>
          These terms govern your use of the Myra platform — for shippers posting loads and carriers accepting them. We&apos;ve written them to be readable, not just defensible.
        </p>

        <h2>Acceptance of Terms</h2>
        <p>
          By accessing or using the Myra platform, including our website, APIs, mobile applications, and related services (collectively, the &ldquo;Service&rdquo;), you agree to be bound by these Terms of Service. If you do not agree to these terms, you may not use the Service.
        </p>
        <p>
          We reserve the right to modify these terms at any time. Material changes will be communicated via email or an in-app notification at least 30 days before taking effect. Your continued use of the Service after changes become effective constitutes acceptance of the revised terms.
        </p>

        <h2>Description of Service</h2>
        <p>
          Myra provides an AI-powered freight brokerage platform that connects shippers, carriers, and brokers. Our services include but are not limited to:
        </p>
        <ul>
          <li>Automated load-to-carrier matching and dispatch</li>
          <li>Real-time GPS shipment tracking and exception alerting</li>
          <li>Rate intelligence and market-aware pricing tools</li>
          <li>Document management for BOLs, PODs, rate confirmations, and compliance records</li>
          <li>Invoicing and payment facilitation between parties</li>
          <li>Carrier compliance verification through FMCSA and insurance databases</li>
        </ul>
        <p>
          Myra acts as a licensed freight broker. We do not own or operate trucks and are not a motor carrier. All transportation services are provided by independent carriers.
        </p>

        <h2>User Responsibilities</h2>
        <p>
          As a user of the Service, you agree to:
        </p>
        <ul>
          <li>Provide accurate, current, and complete information during registration and throughout your use of the platform</li>
          <li>Maintain the security of your account credentials and immediately notify us of any unauthorized access</li>
          <li>Comply with all applicable federal, state, and local laws and regulations, including FMCSA regulations for carriers</li>
          <li>Not use the Service for any unlawful purpose or in any way that could damage, disable, or impair the platform</li>
          <li>Maintain valid and current operating authority, insurance, and safety ratings as required for your role (carriers)</li>
          <li>Ensure all shipment information provided is accurate, including weight, dimensions, commodity type, and hazmat classifications (shippers)</li>
        </ul>

        <h2>Limitation of Liability</h2>
        <p>
          To the maximum extent permitted by applicable law, Myra AI, Inc. and its officers, directors, employees, and agents shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including but not limited to loss of profits, data, or goodwill, arising out of or in connection with your use of the Service.
        </p>
        <p>
          Our total liability for any claims arising under these terms shall not exceed the total fees paid by you to Myra during the twelve (12) months preceding the claim. This limitation applies regardless of the theory of liability, whether based on contract, tort, negligence, strict liability, or otherwise.
        </p>
        <p>
          Myra does not guarantee the availability, timeliness, or reliability of any carrier or shipment. While we employ rigorous vetting and matching algorithms, we are not responsible for the actions or omissions of independent carriers, including but not limited to delays, damage, or loss of freight.
        </p>

        <h2>Governing Law</h2>
        <p>
          These Terms of Service shall be governed by and construed in accordance with the laws of the State of Delaware, without regard to its conflict of law provisions. Any disputes arising under or in connection with these terms shall be resolved exclusively in the federal or state courts located in Wilmington, Delaware.
        </p>
        <p>
          For claims subject to arbitration, the parties agree to binding arbitration administered by the American Arbitration Association under its Commercial Arbitration Rules. The arbitration shall take place in Wilmington, Delaware, and the arbitrator&apos;s decision shall be final and binding.
        </p>

        <h2>Contact Us</h2>
        <p>
          If you have any questions about these Terms of Service, please contact us at:
        </p>
        <p>
          <a href="mailto:legal@myra-ai.com">legal@myra-ai.com</a>
        </p>
      </div>
    </>
  )
}
