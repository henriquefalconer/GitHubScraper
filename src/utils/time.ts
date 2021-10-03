import moment from 'moment';

export const wait = (milliseconds: number) =>
  new Promise<void>((res) => setTimeout(res, milliseconds));

export const getPreviousWeek = (date: string) =>
  moment(date, 'YYYY-MM-DD').subtract(1, 'week').format('YYYY-MM-DD');

export const getFormattedTime = () => moment().format('HH:mm:ss.SS');
