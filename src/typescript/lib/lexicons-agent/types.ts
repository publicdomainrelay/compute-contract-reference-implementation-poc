// TypeScript types for the com.publicdomainrelay.temp.agent.* lexicons.
// Shapes mirror the JSON files in ./lexicons/.

import type { StrongRef } from "../lexicons-market/types.ts";

/** com.publicdomainrelay.temp.agent.skill#propertyReference */
export type PropertyReference = {
  path: string;
  ref?: StrongRef;
};

/** com.publicdomainrelay.temp.agent.skill */
export type AgentSkill = {
  name: string;
  description: string;
  content: string;
  examples?: StrongRef[];
  property_references?: PropertyReference[];
  createdAt: string;
};

/** com.publicdomainrelay.temp.agent.class */
export type AgentClass = {
  name: string;
  description: string;
  skills: StrongRef[];
  parent?: StrongRef;
  spawnsSubAgent?: boolean;
  createdAt: string;
};
