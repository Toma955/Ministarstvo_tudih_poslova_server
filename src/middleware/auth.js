import jwt from "jsonwebtoken";
import { config } from "../config.js";

export function signToken(payload) {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

export function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret);
}

export function authMiddleware(requiredRole = null) {
  return (req, res, next) => {
    const header = req.headers.authorization || "";
    const [, token] = header.split(" ");

    if (!token) {
      return res.status(401).json({ error: "unauthorized", message: "Nedostaje token." });
    }

    try {
      const decoded = verifyToken(token);
      req.auth = decoded;

      if (requiredRole && decoded.role !== requiredRole) {
        return res.status(403).json({ error: "forbidden", message: "Nedovoljna prava." });
      }

      next();
    } catch {
      return res.status(401).json({ error: "unauthorized", message: "Token nije valjan." });
    }
  };
}

export function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || "";
  const [, token] = header.split(" ");
  if (token) {
    try {
      req.auth = verifyToken(token);
    } catch {
      req.auth = null;
    }
  }
  next();
}

export function apiVersionMiddleware(req, res, next) {
  res.setHeader("X-MK-API-Version", String(config.apiVersion));
  next();
}
