/** Begin Google OAuth at the same origin that is serving the product. */
export const startLogin = () => {
  window.location.assign("/api/auth/google/start");
};
