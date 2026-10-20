export const basicAnswers = { nationality: "CN", residence: "CN", applicationCity: "北京", destination: "IS", purpose: "tourism",
  arrivalDate: "2027-06-01", departureDate: "2027-06-03", ageGroup: "adult", otherSchengenCountries: "no" };
export function decisionScenarios() {
  const scenarios = [{ name: "empty application", answers: {} }], branches = [];
  for (const occupation of ["employed", "retired", "unemployed"]) for (const maritalStatus of ["married", "single", "divorced", "widowed"]) for (const sponsor of ["self", "spouse", "other"]) {
    branches.push({ ageGroup: "adult", occupation, maritalStatus, sponsor });
  }
  for (const inSchool of ["yes", "no"]) for (const minorTravel of ["alone", "one_parent", "both_parents", "other_guardian"]) for (const guardianAbroad of ["yes", "no"]) {
    branches.push({ ageGroup: "minor", inSchool, minorTravel, guardianAbroad, occupation: "unemployed", sponsor: "other" });
  }
  const trips = [{ otherSchengenCountries: "no" }, ...["yes", "no", "unsure"].map((icelandMainDestination) => ({ otherSchengenCountries: "yes", icelandMainDestination }))];
  for (const branch of branches) for (const trip of trips) {
    const answers = { ...basicAnswers, ...branch, ...trip }, label = [branch.ageGroup, branch.occupation, branch.maritalStatus, branch.sponsor, branch.inSchool, branch.minorTravel, branch.guardianAbroad, trip.otherSchengenCountries, trip.icelandMainDestination].filter(Boolean).join("/");
    scenarios.push({ name: label, answers });
    for (const field of Object.keys(answers)) { const partial = { ...answers }; delete partial[field]; scenarios.push({ name: `${label}/missing:${field}`, answers: partial }); }
  }
  for (const field of ["nationality", "residence", "destination", "purpose"]) scenarios.push({ name: `unsupported:${field}`, answers: { ...basicAnswers, occupation: "employed", [field]: "other" } });
  for (const departureDate of ["2027-06-01", "2027-05-31"]) scenarios.push({ name: `invalid travel order:${departureDate}`, answers: { ...basicAnswers, occupation: "employed", departureDate } });
  return scenarios;
}
