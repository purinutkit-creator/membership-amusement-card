import { Suspense, lazy } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { ToastProvider, ConfirmProvider, Skeleton } from './components/ui.jsx';
import { AuthProvider, useAuth } from './lib/auth.jsx';
import Layout from './components/Layout.jsx';
import { useAdminTranslation } from './lib/adminI18n.jsx';

const L = (f) => lazy(f);
// admin
const Login = L(() => import('./pages/admin/Login.jsx'));
const Setup = L(() => import('./pages/admin/Setup.jsx'));
const SetupWizard = L(() => import('./pages/admin/SetupWizard.jsx'));
const Dashboard = L(() => import('./pages/admin/Dashboard.jsx'));
const OwnerDashboard = L(() => import('./pages/admin/OwnerDashboard.jsx'));
const POS = L(() => import('./pages/admin/POS.jsx'));
const TopUp = L(() => import('./pages/admin/TopUp.jsx'));
const Members = L(() => import('./pages/admin/Members.jsx'));
const MemberDetail = L(() => import('./pages/admin/MemberDetail.jsx'));
const Cards = L(() => import('./pages/admin/Cards.jsx'));
const CardDetail = L(() => import('./pages/admin/CardDetail.jsx'));
const Stamps = L(() => import('./pages/admin/Stamps.jsx'));
const Points = L(() => import('./pages/admin/Points.jsx'));
const Rewards = L(() => import('./pages/admin/Rewards.jsx'));
const Orders = L(() => import('./pages/admin/Orders.jsx'));
const OrderDetail = L(() => import('./pages/admin/OrderDetail.jsx'));
const Shifts = L(() => import('./pages/admin/Shifts.jsx'));
const Transactions = L(() => import('./pages/admin/Transactions.jsx'));
const TransactionDetail = L(() => import('./pages/admin/TransactionDetail.jsx'));
const Machines = L(() => import('./pages/admin/Machines.jsx'));
const Terminals = L(() => import('./pages/admin/Terminals.jsx'));
const Promotions = L(() => import('./pages/admin/Promotions.jsx'));
const Products = L(() => import('./pages/admin/Products.jsx'));
const CustomerDisplays = L(() => import('./pages/admin/CustomerDisplays.jsx'));
const PromotionDisplays = L(() => import('./pages/admin/PromotionDisplays.jsx'));
const Devices = L(() => import('./pages/admin/Devices.jsx'));
const Printers = L(() => import('./pages/admin/Printers.jsx'));
const MediaLibrary = L(() => import('./pages/admin/MediaLibrary.jsx'));
const Staff = L(() => import('./pages/admin/Staff.jsx'));
const Roles = L(() => import('./pages/admin/Roles.jsx'));
const Branches = L(() => import('./pages/admin/Branches.jsx'));
const Reports = L(() => import('./pages/admin/Reports.jsx'));
const AuditLogs = L(() => import('./pages/admin/AuditLogs.jsx'));
const Settings = L(() => import('./pages/admin/Settings.jsx'));
// device / customer surfaces
const Terminal = L(() => import('./pages/device/Terminal.jsx'));
const CustomerDisplay = L(() => import('./pages/device/CustomerDisplay.jsx'));
const Signage = L(() => import('./pages/device/Signage.jsx'));
const CheckBalance = L(() => import('./pages/device/CheckBalance.jsx'));
// member portal
const Portal = L(() => import('./pages/member/Portal.jsx'));
const CardPortal = L(() => import('./pages/member/CardPortal.jsx'));
const PublicReceipt = L(() => import('./pages/member/PublicReceipt.jsx'));

function Loading() { return <div className="content"><Skeleton rows={6} height={22} /></div>; }

function RequireStaff({ children }) {
  const { loading, staff, settings } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!staff) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (settings && !settings.setup?.completed && staff.permissions?.includes('settings.edit') && !loc.pathname.startsWith('/setup')) return <Navigate to="/setup/wizard" replace />;
  return children;
}

function Admin() {
  useAdminTranslation();
  return (
    <AuthProvider>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="/setup/wizard" element={<RequireStaff><SetupWizard /></RequireStaff>} />
          <Route element={<RequireStaff><Layout /></RequireStaff>}>
            <Route index element={<Dashboard />} />
            <Route path="owner" element={<OwnerDashboard />} />
            <Route path="pos" element={<POS />} />
            <Route path="topup" element={<TopUp />} />
            <Route path="members" element={<Members />} />
            <Route path="members/:id" element={<MemberDetail />} />
            <Route path="cards" element={<Cards />} />
            <Route path="cards/:id" element={<CardDetail />} />
            <Route path="stamps" element={<Stamps />} />
            <Route path="points" element={<Points />} />
            <Route path="rewards" element={<Rewards />} />
            <Route path="orders" element={<Orders />} />
            <Route path="orders/:id" element={<OrderDetail />} />
            <Route path="shifts" element={<Shifts />} />
            <Route path="transactions" element={<Transactions />} />
            <Route path="transactions/:id" element={<TransactionDetail />} />
            <Route path="machines" element={<Machines />} />
            <Route path="terminals" element={<Terminals />} />
            <Route path="promotions" element={<Promotions />} />
            <Route path="products" element={<Products />} />
            <Route path="customer-displays" element={<CustomerDisplays />} />
            <Route path="promotion-displays" element={<PromotionDisplays />} />
            <Route path="devices" element={<Devices />} />
            <Route path="printers" element={<Printers />} />
            <Route path="media" element={<MediaLibrary />} />
            <Route path="staff" element={<Staff />} />
            <Route path="roles" element={<Roles />} />
            <Route path="branches" element={<Branches />} />
            <Route path="reports" element={<Reports />} />
            <Route path="audit" element={<AuditLogs />} />
            <Route path="settings" element={<Settings />} />
            <Route path="settings/:section" element={<Settings />} />
            <Route path="*" element={<div className="empty">Page not found</div>} />
          </Route>
        </Routes>
      </Suspense>
    </AuthProvider>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/terminal" element={<Terminal />} />
            <Route path="/display" element={<CustomerDisplay />} />
            <Route path="/signage" element={<Signage />} />
            <Route path="/kiosk" element={<CheckBalance />} />
            <Route path="/m/*" element={<Portal />} />
            <Route path="/c/:token" element={<CardPortal />} />
            <Route path="/r/:token" element={<PublicReceipt />} />
            <Route path="/*" element={<Admin />} />
          </Routes>
        </Suspense>
      </ConfirmProvider>
    </ToastProvider>
  );
}
