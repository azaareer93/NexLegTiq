import axios from 'axios';

import { apiHost, apiPort } from './env';

axios.defaults.baseURL = `http://${apiHost}:${apiPort}`;
