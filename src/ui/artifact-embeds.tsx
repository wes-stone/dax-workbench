import { createContext, useContext, type ReactNode } from "react";

export interface ResearchPresentation {
  numbers: "readable" | "exact";
  /** Receives the full artifact:<UUID> catalog ID; resolve known local snapshots only. */
  renderArtifact?: (id: string, alt: string) => ReactNode;
}

const ResearchPresentationContext = createContext<ResearchPresentation>({ numbers: "exact" });

/** Opt research previews in without changing model notes, stored Markdown or code. */
export function ResearchPresentationProvider({ children, ...presentation }: ResearchPresentation & { children: ReactNode }) {
  return <ResearchPresentationContext.Provider value={presentation}>{children}</ResearchPresentationContext.Provider>;
}

export function useResearchPresentation(): ResearchPresentation {
  return useContext(ResearchPresentationContext);
}
