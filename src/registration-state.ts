let droppedUnknownRegistrations = 0;

export function recordDroppedUnknownRegistration(): void {
  droppedUnknownRegistrations += 1;
}

export function droppedUnknownRegistrationCount(): number {
  return droppedUnknownRegistrations;
}

export function resetRegistrationStateForTest(): void {
  droppedUnknownRegistrations = 0;
}
