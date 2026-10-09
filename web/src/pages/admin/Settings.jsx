import { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { Card, Select, useLoad } from '../../components/ui.jsx';
import { SettingsGroupForm, FontsForm, PaymentMethodsForm, PrivacyPolicies, GROUPS } from './settingsSections.jsx';
import { TiersManager, StampRulesManager, BranchesManager } from './managers.jsx';

const SECTIONS = [
  ['general', 'General'], ['branding', 'Branding'], ['theme', 'Theme'], ['fonts', 'Fonts'], ['language', 'Language'], ['member', 'Member'], ['card', 'Card'], ['wallet', 'Wallet'],
  ['topup', 'Top Up'], ['tier', 'Tier'], ['point', 'Point'], ['stamp', 'M-Stamp'], ['reward', 'Reward'], ['arcade', 'Arcade'], ['promotion', 'Promotion'], ['payment', 'Payment'],
  ['promptpay', 'PromptPay'], ['receipt', 'Receipt'], ['printer', 'Printer'], ['display', 'Customer Display'], ['privacy', 'Privacy'], ['security', 'Security'], ['device', 'Device'],
  ['branch', 'Branch'], ['notification', 'Notification'], ['sound', 'Sound'], ['integration', 'Integration'],
];
const BRANCHABLE = ['general', 'receipt', 'tax', 'promptpay', 'bank', 'display', 'card', 'wallet', 'topup', 'point', 'stamp', 'promotion', 'sound'];

export default function Settings() {
  const { section = 'general' } = useParams();
  const nav = useNavigate();
  const branches = useLoad(() => api.get('/branches'), []);
  const [branchId, setBranchId] = useState('');
  useEffect(() => { if (!BRANCHABLE.includes(section) && section !== 'payment') setBranchId(''); }, [section]);
  const scoped = branchId || null;
  const body = (() => {
    switch (section) {
      case 'fonts': return <FontsForm />;
      case 'tier': return <div className="col"><SettingsGroupForm group="tier" /><TiersManager /></div>;
      case 'stamp': return <div className="col"><SettingsGroupForm group="stamp" branchId={scoped} /><StampRulesManager /></div>;
      case 'payment': return <div className="col"><PaymentMethodsForm /><SettingsGroupForm group="tax" branchId={scoped} /><SettingsGroupForm group="bank" branchId={scoped} /></div>;
      case 'printer': return <Card title="Printers">Printers are managed per device / branch. <Link to="/printers">Open printer management →</Link><div className="mt"><SettingsGroupForm group="receipt" branchId={scoped} hideTitle /></div></Card>;
      case 'privacy': return <div className="col"><SettingsGroupForm group="privacy" /><PrivacyPolicies /></div>;
      case 'branch': return <BranchesManager />;
      default: return GROUPS[section] ? <SettingsGroupForm key={`${section}${scoped}`} group={section} branchId={scoped} /> : <div>Unknown section</div>;
    }
  })();
  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(180px, 230px) 1fr', alignItems: 'start' }}>
      <div className="card tight col gap-s" style={{ position: 'sticky', top: 76 }}>
        <select className="input only-mobile" value={section} onChange={(e) => nav(`/settings/${e.target.value}`)}>{SECTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <div className="hide-mobile col gap-s">{SECTIONS.map(([k, l]) => <a key={k} href={`/settings/${k}`} onClick={(e) => { e.preventDefault(); nav(`/settings/${k}`); }} className={`nav-link ${section === k ? 'active' : ''}`}>{l}</a>)}</div>
      </div>
      <div className="col">
        {(BRANCHABLE.includes(section) || section === 'payment') && (branches.data?.items.length || 0) > 1 && (
          <div className="card tight row"><span className="small muted">Scope:</span>
            <div style={{ width: 280 }}><Select value={branchId} onChange={(e) => setBranchId(e.target.value)} options={[{ value: '', label: 'Global (all branches)' }, ...branches.data.items.map((b) => ({ value: b.id, label: `Branch override: ${b.name}` }))]} /></div></div>
        )}
        <div className="card">{body}</div>
      </div>
    </div>
  );
}
