function text(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
}

export function occurrenceStorageKey(occurrenceId) {
    const id = text(occurrenceId);
    if (!/^occ_[a-f0-9]{24,}$/i.test(id)) throw new Error('Invalid occurrenceId');
    return `occurrences/${id}.json`;
}
