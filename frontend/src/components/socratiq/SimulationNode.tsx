
import React, { useMemo, useState } from 'react';
import { Lock, Unlock, ShieldAlert } from 'lucide-react';
import { SIMULATION_SANDBOX, buildSimulationSrcDoc, validateSimulationCode } from '@/lib/smartboard/simulationDoc';

interface SimulationNodeProps {
  code: string;
  width: number;
  height: number;
  title: string;
  selected: boolean;
}

export const SimulationNode: React.FC<SimulationNodeProps> = ({ code, width, height, title, selected }) => {
  // Default to interactive (true)
  const [isInteractive, setIsInteractive] = useState(true);

  // Same hardened document, CSP, sandbox and code validation as the pop-out panel (see lib/smartboard/simulationDoc).
  const validation = useMemo(() => validateSimulationCode(code), [code]);
  const srcDoc = useMemo(() => (validation.safe ? buildSimulationSrcDoc(code) : ''), [code, validation.safe]);

  return (
    <div 
      className={`relative bg-white rounded-lg shadow-xl overflow-hidden border-2 flex flex-col transition-shadow ${selected ? 'border-blue-500 ring-2 ring-blue-200' : 'border-gray-300'}`}
      style={{ width, height }}
    >
      {/* Header Bar - Always allow dragging from here if configured in parent, 
          but we need to stop propagation of click to prevent selecting text inside?
          Actually, the parent handles drag on pointer down. We just need to ensure this header
          doesn't block that pointer down event.
      */}
      <div className="bg-gray-100 px-3 py-1.5 border-b border-gray-200 flex justify-between items-center select-none cursor-move">
        <span className="font-semibold text-xs text-gray-700 flex items-center gap-1 pointer-events-none">
           {title}
        </span>
        <div className="flex gap-2 pointer-events-auto" onPointerDown={e => e.stopPropagation()}>
            <button 
                onClick={() => setIsInteractive(!isInteractive)}
                className={`p-1 rounded hover:bg-gray-200 transition-colors ${isInteractive ? 'text-green-600' : 'text-gray-500'}`}
                title={isInteractive ? "Interactive Mode (Click to Lock for easier moving)" : "Locked (Easy Moving)"}
            >
                {isInteractive ? <Unlock size={14} /> : <Lock size={14} />}
            </button>
        </div>
      </div>

      <div className="flex-1 relative bg-white">
        {!code || !code.trim() ? (
          <div role="alert" className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-slate-600">
            <ShieldAlert size={28} className="text-amber-500" />
            <span>This simulation has no code to run. Ask SocratiQ to regenerate it.</span>
          </div>
        ) : !validation.safe ? (
          <div role="alert" className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-red-700">
            <ShieldAlert size={28} />
            <span>Simulation blocked for unsafe code: {validation.violations.join(', ')}.</span>
          </div>
        ) : (
          <iframe
            srcDoc={srcDoc}
            className="w-full h-full border-none block"
            title={title}
            sandbox={SIMULATION_SANDBOX}
            style={{ pointerEvents: isInteractive ? 'auto' : 'none' }}
          />
        )}

        {/* Interaction Blocker Overlay: Catch clicks if locked */}
        {!isInteractive && (
            <div className="absolute inset-0 bg-transparent cursor-move" />
        )}
      </div>

      {/* Resize Handle Indicator */}
      {selected && (
          <div className="absolute bottom-0 right-0 p-1 cursor-nwse-resize pointer-events-none">
              <div className="w-4 h-4 bg-blue-500 rounded-tl-lg opacity-50" />
          </div>
      )}
    </div>
  );
};
