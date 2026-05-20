import { redirect } from 'next/navigation';

// /m → default selection screen.
export default function MobileIndex() {
  redirect('/m/select');
}
