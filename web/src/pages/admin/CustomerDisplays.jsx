import { MonitorPlay, ExternalLink } from 'lucide-react';
import { Card, PageHeader, Button } from '../../components/ui.jsx';
import { SettingsGroupForm } from './settingsSections.jsx';
import { DeviceManager } from './Devices.jsx';
import { useAuth } from '../../lib/auth.jsx';

export default function CustomerDisplays() {
  const { can } = useAuth();
  return (
    <div className="col">
      <PageHeader title="Customer Displays" subtitle="Second screen facing the customer — paired to a POS with a 6-digit code" actions={<a className="btn" href="/display" target="_blank" rel="noreferrer"><ExternalLink size={16} /> Open display page</a>} />
      <Card><div className="row top"><MonitorPlay size={36} color="var(--primary)" /><ol className="small" style={{ margin: 0 }}>
        <li>On the customer-facing screen open <code>{location.origin}/display</code>.</li><li>At the POS press <b>Connect Customer Display</b> → a 6-digit code appears.</li>
        <li>Enter the code on the display. It then mirrors the cart, shows PromptPay QR, asks "Are you a member?", phone input, card tap, privacy consent — in TH / EN / 中文.</li></ol></div></Card>
      {can('settings.view') && <Card><SettingsGroupForm group="display" /></Card>}
      <DeviceManager type="CUSTOMER_DISPLAY" title="Paired displays" subtitle="Registered automatically when a display pairs" />
      <span hidden><Button /></span>
    </div>
  );
}
