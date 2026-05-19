import { redirect } from 'next/navigation';

// /m → écran de sélection par défaut.
export default function MobileIndex() {
  redirect('/m/select');
}
