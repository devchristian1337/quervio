import {create} from "zustand";
export const useOperations=create<{running:Record<string,string>;begin:(id:string,label:string)=>void;end:(id:string)=>void}>((set)=>({
  running:{},begin:(id,label)=>set(s=>({running:{...s.running,[id]:label}})),end:id=>set(s=>{const running={...s.running};delete running[id];return {running};}),
}));
