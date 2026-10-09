import { DeviceManager } from './Devices.jsx';
import { Card } from '../../components/ui.jsx';
export default function Terminals() {
  return (
    <div className="col">
      <Card><div className="small">A <b>Card Tap Terminal</b> is a tablet / screen mounted at a machine. Create the terminal device here, link it to the machine (Machines → edit → Reader / terminal device), click <b>Activate</b> and enter the 6-digit code on <code>{location.origin}/terminal</code>. Taps are processed server-side atomically; the terminal shows OFFLINE and refuses taps without a live connection.</div></Card>
      <DeviceManager type="ARCADE_TERMINAL" title="Card Terminals" subtitle="Tap-to-play terminals at machines & attractions" />
    </div>
  );
}
