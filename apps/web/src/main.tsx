import { render } from 'preact';
import { App, initLite } from './App';
import { createApi } from './api';
import './styles.css';

/**
 * Same-origin by default. The client holds no provider key and no database
 * credential — everything it can do, it does by asking the API (§1) — so there
 * is nothing here to configure per environment except where that API lives.
 */
const api = createApi(import.meta.env['VITE_API_BASE'] ?? '');

initLite();

const root = document.getElementById('app');
if (root) render(<App api={api} />, root);
