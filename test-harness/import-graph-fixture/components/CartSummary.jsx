import { formatPrice } from '../lib/formatPrice';
import './CartSummary.module.css';
import '../styles/brand.css';

export function CartSummary({ items }) {
  return <aside>{formatPrice(items.length)}</aside>;
}
