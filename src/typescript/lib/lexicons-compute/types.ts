// TypeScript types for the com.publicdomainrelay.temp.compute.* lexicons.
// Shapes mirror the JSON files in ./lexicons/.

/** com.publicdomainrelay.temp.compute.vm#location */
export type ComputeVMLocation = {
  country?: string;
  region?: string;
};

/** com.publicdomainrelay.temp.compute.vm */
export type ComputeVM = {
  cpus: number;
  mem: string;
  disk: string;
  network: string;
  location?: ComputeVMLocation;
  role: string;
  user_data: string;
};

/** com.publicdomainrelay.temp.compute.config.wif.simple */
export type ComputeConfigWifSimple = {
  accept_path: string;
  issuer_uri: string;
  to_issue: string;
  actx_path?: string;
  token_path: string;
  url_path: string;
  url_route: string;
  subject: string;
};

/** com.publicdomainrelay.temp.compute.events.vm.delete */
export type VMDeleteEvent = {
  reason: string;
};
