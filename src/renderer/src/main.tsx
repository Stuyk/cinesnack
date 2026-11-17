import { render } from 'solid-js/web'
import App from './App'
import RecorderWidget from './components/RecorderWidget'
import './index.css'

const root = document.getElementById('root')

if (root) {
  // Drop the static splash; the app shows its own boot screen until ffmpeg is ready.
  root.textContent = ''
  render(() => (location.hash === '#widget' ? <RecorderWidget /> : <App />), root)
}
