import Link from 'next/link';
import { AllocationReport } from '@/components/allocation-report';
import '../launch.css';

export default function AllocationsPage() {
  return (
    <main className="launch-page">
      <nav className="launch-nav" aria-label="Allocation navigation"><Link href="/">← Back to the show</Link><span>PEPE &amp; CHAD / PUBLIC RECORD</span></nav>
      <div className="launch-page-heading"><p className="launch-kicker">TOKEN TRANSPARENCY</p><h1>Project allocations</h1><p>Declared ownership, planned allocations and a dated record of the project’s wallets.</p></div>
      <AllocationReport />
    </main>
  );
}
