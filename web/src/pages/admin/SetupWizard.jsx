import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, ChevronLeft, ChevronRight, Rocket, Gamepad2, Trees, Baby, UtensilsCrossed, Shuffle } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { Button, useAction, Card } from '../../components/ui.jsx';
import { SettingsGroupForm, FontsForm, PaymentMethodsForm } from './settingsSections.jsx';
import { TiersManager, BranchesManager } from './managers.jsx';
import { PrinterList } from './Printers.jsx';

const TYPES = [
  ['AMUSEMENT_ARCADE', 'Amusement Arcade', Gamepad2, { arcade: true, food: false }], ['THEME_PARK', 'Theme Park', Trees, { arcade: true, food: true }],
  ['INDOOR_PLAYGROUND', 'Indoor Playground', Baby, { arcade: true, food: false }], ['FOOD_PARK', 'Food Park', UtensilsCrossed, { arcade: false, food: true }], ['HYBRID', 'Hybrid', Shuffle, { arcade: true, food: true }],
];

function BusinessType({ next }) {
  const { settings, refresh } = useAuth();
  const [run, busy] = useAction();
  const pick = async ([code, , , mods]) => {
    await run(() => api.put('/settings/general', { value: { businessType: code, modules: { ...settings.general.modules, ...mods } } }));
    await refresh(); next();
  };
  return (
    <div className="col"><h2>What kind of business is this?</h2><p className="muted">Modules can be switched on/off later in Settings → General.</p>
      <div className="auto-grid">{TYPES.map((t) => { const [code, label, Icon] = t; return (
        <button key={code} className={`tile ${settings.general.businessType === code ? 'selected' : ''}`} disabled={busy} onClick={() => pick(t)} style={{ minHeight: 140, alignItems: 'center', justifyContent: 'center' }}><Icon size={40} color="var(--primary)" /><b>{label}</b></button>); })}</div>
    </div>
  );
}

export default function SetupWizard() {
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [step, setStep] = useState(0);
  const [run, busy] = useAction();
  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));
  const STEPS = [
    ['Business Type', <BusinessType key="bt" next={next} />],
    ['Store Information', <SettingsGroupForm key="g" group="general" onSaved={next} saveLabel="Save & continue" />],
    ['Logo', <SettingsGroupForm key="b" group="branding" onSaved={next} saveLabel="Save & continue" />],
    ['Theme', <SettingsGroupForm key="t" group="theme" onSaved={next} saveLabel="Save & continue" />],
    ['Font', <FontsForm key="f" onSaved={next} />],
    ['Branch', <BranchesManager key="br" />],
    ['Payment', <div key="p" className="col"><PaymentMethodsForm /><SettingsGroupForm group="tax" saveLabel="Save tax & continue" onSaved={next} /></div>],
    ['PromptPay', <SettingsGroupForm key="pp" group="promptpay" onSaved={next} saveLabel="Save & continue" />],
    ['Card', <SettingsGroupForm key="c" group="card" onSaved={next} saveLabel="Save & continue" />],
    ['Member Tier', <TiersManager key="tr" />],
    ['Point', <SettingsGroupForm key="pt" group="point" onSaved={next} saveLabel="Save & continue" />],
    ['M-Stamp', <SettingsGroupForm key="st" group="stamp" onSaved={next} saveLabel="Save & continue" />],
    ['Printer', <PrinterList key="pr" />],
    ['Customer Display', <SettingsGroupForm key="d" group="display" onSaved={next} saveLabel="Save & continue" />],
    ['Ready', <div key="r" className="fs-center" style={{ position: 'static' }}><Rocket size={64} color="var(--primary)" /><h1>You're ready!</h1><p className="muted">Everything can be changed later in Settings.</p>
      <Button variant="primary" size="xl" loading={busy} onClick={async () => { await run(() => api.post('/setup/complete')); await refresh(); nav('/'); }}>Finish setup</Button></div>],
  ];
  return (
    <div className="content" style={{ maxWidth: 1100 }}>
      <h1>First Setup Wizard</h1>
      <div className="steps">{STEPS.map(([l], i) => <button key={l} type="button" className={`step ${i === step ? 'active' : i < step ? 'done' : ''}`} style={{ border: 0, cursor: 'pointer' }} onClick={() => setStep(i)}>{i < step ? <Check size={14} /> : i + 1}. {l}</button>)}</div>
      <Card>{STEPS[step][1]}</Card>
      <div className="row between mt">
        <Button icon={ChevronLeft} disabled={step === 0} onClick={() => setStep(step - 1)}>Back</Button>
        {step < STEPS.length - 1 && <Button icon={ChevronRight} onClick={next}>Skip / Next</Button>}
      </div>
    </div>
  );
}
