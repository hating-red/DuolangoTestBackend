export function calculateEndTime(startTime, hours) {
  if (!startTime || !hours) return '';
  
  try {
    const [startHours, startMinutes] = startTime.split(':').map(Number);
    const totalMinutes = startHours * 60 + startMinutes + Math.round(hours * 60);
    
    const endHours = Math.floor(totalMinutes / 60) % 24;
    const endMinutes = totalMinutes % 60;
    
    return `${endHours.toString().padStart(2, '0')}:${endMinutes.toString().padStart(2, '0')}`;
  } catch (error) {
    return '';
  }
}