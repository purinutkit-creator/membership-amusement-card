import { useParams } from 'react-router-dom';
import { Printer } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useLoad, Button, ErrorState, Skeleton } from '../../components/ui.jsx';
import { ReceiptView } from '../../components/domain.jsx';
import { browserPrint } from '../../lib/printer.js';

/** Digital receipt opened from the receipt QR code. */
export default function PublicReceipt() {
  const { token } = useParams();
  const st = useLoad(() => api.get(`/public/receipts/${token}`), [token]);
  if (st.error) return <ErrorState error={st.error} />;
  if (!st.data) return <div className="content"><Skeleton /></div>;
  return (
    <div className="content col" style={{ alignItems: 'center' }}>
      <div className="card" style={{ background: '#fff' }}><ReceiptView data={st.data.data} width="80" /></div>
      <Button icon={Printer} className="no-print" onClick={() => browserPrint('receipt-print')}>Print / Save PDF</Button>
    </div>
  );
}
