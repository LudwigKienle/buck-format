import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Circle, Layers, SlidersHorizontal } from 'lucide-react';
import { BuckEditor } from './editor/BuckEditor';
import '../style.css';
import './editor/buck.css';
/** Standalone .buck editor page: own shell around BuckEditor. */
function BuckApp(){
  return <>
    <header className="buck-app-header">
      <a className="buck-brand" href="./" aria-label="Buckswood .buck Editor"><Layers size={28} strokeWidth={1.5}/><strong>BUCKSWOOD</strong><span>/ .buck Editor</span></a>
      <span className="buck-app-tag">Entwurf 0.1 · Farbe · Nebel · Tiefenschärfe · Licht</span>
      <nav className="buck-app-nav" aria-label="Weitere Werkzeuge">
        <a href="https://github.com/LudwigKienle/buck-format" className="buck-app-link" target="_blank" rel="noreferrer"><SlidersHorizontal size={14}/>GitHub</a>
        <span className="buck-app-status"><Circle size={9} fill="currentColor"/>Lokal · Keine Uploads</span>
      </nav>
    </header>
    <BuckEditor/>
  </>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><BuckApp/></StrictMode>);
